import { baseName, cap, classifyLimit, epochMs, finalizeEvents, firstLine, laneOfTool, lineCount, readJsonl, resetFromText, time, toolTitle } from './common.js';
import type { FileTouch, Session, TraceEvent, Usage } from '../types.js';

/** These records are large and carry nothing the timeline needs. */
const NOISE = /^\{"(?:type|kind)":"(?:api-request-blob|api-request-shape|api-request|file-history-snapshot|file-history-delta|queue-operation|last-prompt|attachment)"/;

const WRAPPER_TAGS = /<(system-reminder|local-command-stdout|local-command-caveat|command-message|command-args)>[\s\S]*?<\/\1>/g;

function promptText(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: '', images: 0 };
  const parts: string[] = [];
  let images = 0;
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'image') images++;
  }
  return { text: parts.join('\n'), images };
}

function cleanPrompt(raw: string): string {
  const command = raw.match(/<command-name>(.*?)<\/command-name>/s)?.[1];
  const args = raw.match(/<command-args>(.*?)<\/command-args>/s)?.[1];
  const text = raw.replace(WRAPPER_TAGS, '').replace(/<command-name>.*?<\/command-name>/gs, '').trim();
  if (command) return [command, args].filter(Boolean).join(' ').trim();
  return text;
}

function toolOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(b => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function readUsage(raw: any): Usage | undefined {
  if (!raw) return undefined;
  const write = Number(raw.cache_creation_input_tokens) || 0;
  const write1h = Number(raw.cache_creation?.ephemeral_1h_input_tokens) || 0;
  return {
    input: Number(raw.input_tokens) || 0,
    output: Number(raw.output_tokens) || 0,
    cacheRead: Number(raw.cache_read_input_tokens) || 0,
    cacheWrite5m: Math.max(write - write1h, 0),
    cacheWrite1h: write1h,
    fast: raw.speed === 'fast' || undefined,
  };
}

function fileOf(name: string, input: any): FileTouch | undefined {
  const path = input?.file_path ?? input?.notebook_path;
  if (typeof path !== 'string') return undefined;
  if (/^(Read|NotebookRead)$/.test(name)) return { path, op: 'read', added: 0, removed: 0 };
  if (name === 'Write') return { path, op: 'create', added: lineCount(String(input.content ?? '')), removed: 0 };
  if (/^(Edit|MultiEdit|NotebookEdit)$/.test(name)) return { path, op: 'edit', added: 0, removed: 0 };
  return undefined;
}

function diffFromInput(input: any): { diff?: string; added: number; removed: number } {
  const edits: any[] = Array.isArray(input?.edits) ? input.edits : [input];
  const lines: string[] = [];
  let added = 0, removed = 0;
  for (const edit of edits) {
    if (typeof edit?.old_string !== 'string' && typeof edit?.new_string !== 'string') continue;
    const before = edit.old_string ? String(edit.old_string).split('\n') : [];
    const after = edit.new_string ? String(edit.new_string).split('\n') : [];
    removed += before.length;
    added += after.length;
    lines.push(...before.map(l => `-${l}`), ...after.map(l => `+${l}`));
  }
  return { diff: lines.length ? lines.join('\n') : undefined, added, removed };
}

/** Applies Claude Code's structured tool result to the matching tool event. */
function applyStructuredResult(event: TraceEvent, result: any): void {
  const tool = event.tool!;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return;
  if (tool.file && tool.file.op !== 'read' && Array.isArray(result.structuredPatch) && result.structuredPatch.length) {
    let added = 0, removed = 0;
    const lines: string[] = [];
    for (const hunk of result.structuredPatch) {
      lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      for (const line of hunk.lines ?? []) {
        lines.push(line);
        if (line[0] === '+') added++;
        else if (line[0] === '-') removed++;
      }
    }
    tool.file.added = added;
    tool.file.removed = removed;
    tool.diff = cap(lines.join('\n'));
  }
  if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
    const text = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (text && !tool.output) tool.output = cap(text);
  }
}

/** `paths[0]` is the main log, the rest are its subagent logs. */
export async function parseClaude(paths: string[]): Promise<Session> {
  const events: TraceEvent[] = [];
  const pendingTools = new Map<string, TraceEvent>();
  const byMessage = new Map<string, TraceEvent>();
  const seen = new Set<string>();
  const models = new Set<string>();
  let customTitle: string | undefined;
  let firstPrompt: string | undefined;
  let project: string | undefined;
  let branch: string | undefined;
  let version: string | undefined;

  const push = (e: Omit<TraceEvent, 'id'>): TraceEvent => {
    const event = { id: 0, ...e };
    events.push(event);
    return event;
  };

  for (const path of paths) {
    for await (const o of readJsonl(path, line => NOISE.test(line))) {
      if (o.type === 'custom-title' && o.customTitle) { customTitle = String(o.customTitle); continue; }
      if (o.type !== 'user' && o.type !== 'assistant' && o.type !== 'system') continue;

      // Resumed sessions replay earlier records with the same uuid.
      if (o.uuid) {
        if (seen.has(o.uuid)) continue;
        seen.add(o.uuid);
      }
      const ts = time(o.timestamp);
      if (!ts) continue;
      project ??= o.cwd;
      branch = o.gitBranch || branch;
      version = o.version || version;
      const sidechain = o.isSidechain ? String(o.agentId ?? 'subagent') : undefined;

      if (o.type === 'system') {
        if (o.subtype === 'compact_boundary') {
          const meta = o.compactMetadata ?? {};
          push({
            ts, durationMs: Number(meta.durationMs) || 0, lane: 'system', kind: 'compact',
            title: `Context compacted (${meta.trigger ?? 'auto'})`, sidechain,
            compact: { trigger: meta.trigger, preTokens: meta.preTokens, postTokens: meta.postTokens },
          });
        }
        continue;
      }

      if (o.type === 'assistant') {
        const message = o.message ?? {};
        // Synthetic records are written by the CLI itself and never billed.
        if (o.isApiErrorMessage || message.model === '<synthetic>') {
          const text = promptText(message.content).text;
          const status = Number(o.apiErrorStatus) || undefined;
          const type = classifyLimit(text, status) ?? (o.error === 'rate_limit' || o.quotaLimits ? 'rate' : undefined);
          if (type) {
            const quota = o.quotaLimits ?? {};
            push({
              ts, durationMs: 0, lane: 'limit', kind: 'limit', title: firstLine(text || 'Rate limited'), text: cap(text), sidechain,
              limit: {
                type,
                status,
                scope: typeof quota.rateLimitType === 'string' ? quota.rateLimitType.replaceAll('_', ' ') : undefined,
                resetsAt: epochMs(quota.resetsAt) ?? resetFromText(text, ts),
              },
            });
          } else if (o.error) {
            push({ ts, durationMs: 0, lane: 'system', kind: 'system', title: firstLine(text || `API error: ${o.error}`), text: cap(text), sidechain });
          }
          continue;
        }
        const model = message.model;
        if (model) models.add(model);
        const usage = model ? readUsage(message.usage) : undefined;
        const blocks = Array.isArray(message.content) ? message.content : [];
        const created: TraceEvent[] = [];
        for (const block of blocks) {
          if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
            const text = String(block.thinking ?? '').trim();
            created.push(push({
              ts, durationMs: Number(o.thinkingDurationMs) || 0, lane: 'think', kind: 'thinking',
              title: text ? `Thinking: ${firstLine(text)}` : 'Thinking (hidden by the model)',
              text: text ? cap(text) : undefined, sidechain, model,
            }));
          } else if (block?.type === 'text' && String(block.text ?? '').trim()) {
            const text = String(block.text);
            created.push(push({ ts, durationMs: 0, lane: 'say', kind: 'text', title: firstLine(text), text: cap(text), sidechain, model }));
          } else if (block?.type === 'tool_use') {
            const name = String(block.name);
            const input = block.input ?? {};
            const event = push({
              ts, durationMs: 0, lane: laneOfTool(name), kind: 'tool', title: toolTitle(name, input), sidechain, model,
              tool: {
                name,
                input: cap(JSON.stringify(input, null, 2)),
                isError: false,
                completed: false,
                command: typeof input.command === 'string' ? input.command : undefined,
                file: fileOf(name, input),
              },
            });
            const fromInput = diffFromInput(input);
            if (event.tool!.file?.op === 'edit') {
              event.tool!.file.added = fromInput.added;
              event.tool!.file.removed = fromInput.removed;
              event.tool!.diff = fromInput.diff && cap(fromInput.diff);
            } else if (event.tool!.file?.op === 'create') {
              event.tool!.diff = cap(String(input.content ?? '').split('\n').map(l => `+${l}`).join('\n'));
            }
            if (block.id) pendingTools.set(String(block.id), event);
            created.push(event);
          }
        }
        // A response spanning several content blocks is logged as several
        // records, each repeating its usage. Count it once, keep the final value.
        if (usage) {
          const key = message.id ? String(message.id) : undefined;
          const earlier = key ? byMessage.get(key) : undefined;
          if (earlier) {
            earlier.usage = usage;
          } else if (created[0]) {
            created[0].usage = usage;
            if (key) byMessage.set(key, created[0]);
          }
        }
        continue;
      }

      // type === 'user': either tool results or a real prompt.
      const content = o.message?.content;
      let hadResult = false;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          hadResult = true;
          const event = pendingTools.get(String(block.tool_use_id));
          if (!event) continue;
          pendingTools.delete(String(block.tool_use_id));
          event.durationMs = Math.max(ts - event.ts, 0);
          event.tool!.completed = true;
          event.tool!.isError = block.is_error === true;
          const output = toolOutput(block.content);
          if (output) event.tool!.output = cap(output);
          applyStructuredResult(event, o.toolUseResult);
        }
      }
      if (hadResult || o.isMeta || o.isCompactSummary) continue;

      const { text: raw, images } = promptText(content);
      const text = cleanPrompt(raw);
      if (!text && !images) continue;
      if (/^\[Request interrupted/.test(text)) {
        push({ ts, durationMs: 0, lane: 'system', kind: 'system', title: 'Interrupted by user', sidechain });
        continue;
      }
      const label = text || `${images} image${images === 1 ? '' : 's'}`;
      if (!sidechain) firstPrompt ??= label;
      push({ ts, durationMs: 0, lane: 'prompt', kind: 'prompt', title: firstLine(label), text: cap(label), sidechain });
    }
  }

  const finalized = finalizeEvents(events);
  const lastEvent = finalized.at(-1);
  return {
    key: baseName(paths[0]!).replace(/\.jsonl$/, ''),
    agent: 'claude-code',
    title: firstLine(customTitle ?? firstPrompt ?? 'Untitled session', 90),
    project,
    branch: branch === 'HEAD' ? undefined : branch,
    agentVersion: version,
    startedAt: finalized[0]?.ts ?? 0,
    endedAt: lastEvent ? Math.max(...finalized.slice(-200).map(e => e.ts + e.durationMs)) : 0,
    models: [...models],
    events: finalized,
  };
}
