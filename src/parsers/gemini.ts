import { readFileSync } from 'node:fs';
import { baseName, cap, classifyLimit, finalizeEvents, firstLine, laneOfTool, lineCount, readJsonl, resetFromText, time, toolTitle } from './common.js';
import type { FileTouch, Session, TraceEvent } from '../types.js';

/** Content is a string, one part, or a list of either. Only text is kept. */
function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(partsText).filter(Boolean).join('\n');
  const part = content as any;
  if (typeof part?.text === 'string') return part.thought ? '' : part.text;
  const response = part?.functionResponse?.response;
  if (response !== undefined) {
    if (typeof response.output === 'string') return response.output;
    if (typeof response.error === 'string') return response.error;
    return JSON.stringify(response);
  }
  return '';
}

function fileOf(name: string, args: any): FileTouch | undefined {
  const path = args?.file_path ?? args?.absolute_path;
  if (typeof path !== 'string') return undefined;
  if (name === 'read_file') return { path, op: 'read', added: 0, removed: 0 };
  if (name === 'write_file') return { path, op: 'create', added: lineCount(String(args.content ?? '')), removed: 0 };
  if (name === 'replace') {
    return { path, op: 'edit', added: lineCount(String(args.new_string ?? '')), removed: lineCount(String(args.old_string ?? '')) };
  }
  return undefined;
}

function applyDisplay(event: TraceEvent, display: any): void {
  const tool = event.tool!;
  if (typeof display === 'string') {
    if (!tool.output) tool.output = cap(display);
    return;
  }
  if (typeof display?.fileDiff === 'string') tool.diff = cap(display.fileDiff);
  const stat = display?.diffStat;
  if (tool.file && stat && typeof stat.model_added_lines === 'number') {
    tool.file.added = stat.model_added_lines;
    tool.file.removed = Number(stat.model_removed_lines) || 0;
  }
}

interface Conversation {
  sessionId?: string;
  summary?: string;
  directories?: string[];
  kind?: string;
  messages: Map<string, any>;
}

function addMessage(c: Conversation, message: any): void {
  // Re-recording an id replaces it. Map keeps the original position.
  c.messages.set(String(message.id), message);
}

function applyPatch(c: Conversation, patch: any): void {
  const updates = [...(patch.updates ?? []), ...(patch.id ? [patch] : [])];
  for (const update of updates) {
    const message = c.messages.get(String(update.id));
    if (!message) continue;
    if (update.content !== undefined) message.content = update.content;
    for (const call of update.toolCalls ?? []) {
      const target = message.toolCalls?.find((t: any) => t.id === call.id);
      if (target && call.result !== undefined) target.result = call.result;
    }
  }
  for (const id of patch.removeIds ?? []) c.messages.delete(String(id));
  if (Array.isArray(patch.orderIds)) {
    const known = patch.orderIds.map(String).filter((id: string) => c.messages.has(id));
    const reordered = new Map(known.map((id: string) => [id, c.messages.get(id)]));
    for (const [id, message] of c.messages) if (!reordered.has(id)) reordered.set(id, message);
    c.messages = reordered as Map<string, any>;
  }
}

function rewindTo(c: Conversation, id: string): void {
  let removing = false;
  for (const key of [...c.messages.keys()]) {
    if (key === id) removing = true;
    if (removing) c.messages.delete(key);
  }
}

/** Current logs are append-only JSONL. Older ones are one JSON document. */
async function readConversation(path: string): Promise<Conversation> {
  const c: Conversation = { messages: new Map() };
  const metadata = (o: any) => {
    c.sessionId = o.sessionId ?? c.sessionId;
    c.summary = o.summary ?? c.summary;
    c.directories = o.directories ?? c.directories;
    c.kind = o.kind ?? c.kind;
    for (const message of o.messages ?? []) addMessage(c, message);
  };
  if (path.endsWith('.json')) {
    metadata(JSON.parse(readFileSync(path, 'utf8')));
    return c;
  }
  for await (const o of readJsonl(path)) {
    if (o.$rewindTo) rewindTo(c, String(o.$rewindTo));
    else if (o.$set) metadata(o.$set);
    else if (o.$patch) applyPatch(c, o.$patch);
    else if (o.id && o.type) addMessage(c, o);
    else metadata(o);
  }
  return c;
}

/** `paths[0]` is the main log, the rest are its subagent logs. */
export async function parseGemini(paths: string[]): Promise<Session> {
  const events: TraceEvent[] = [];
  const models = new Set<string>();
  let main: Conversation | undefined;
  let firstPrompt: string | undefined;

  const push = (e: Omit<TraceEvent, 'id'>): TraceEvent => {
    const event = { id: 0, ...e };
    events.push(event);
    return event;
  };

  for (const path of paths) {
    const conversation = await readConversation(path);
    main ??= conversation;
    const sidechain = conversation !== main || conversation.kind === 'subagent'
      ? (conversation.sessionId ?? baseName(path)).slice(0, 8)
      : undefined;
    const messages = [...conversation.messages.values()];

    messages.forEach((m, index) => {
      const ts = time(m.timestamp);
      if (!ts) return;
      const text = partsText(m.displayContent ?? m.content).trim();

      if (m.type === 'user') {
        if (!text) return;
        if (!sidechain) firstPrompt ??= text;
        push({ ts, durationMs: 0, lane: 'prompt', kind: 'prompt', title: firstLine(text), text: cap(text), sidechain });
        return;
      }
      if (m.type === 'info' || m.type === 'warning' || m.type === 'error') {
        const type = classifyLimit(text);
        if (type) {
          push({
            ts, durationMs: 0, lane: 'limit', kind: 'limit', title: firstLine(text), text: cap(text), sidechain,
            limit: { type, resetsAt: resetFromText(text, ts) },
          });
        } else if (m.type === 'error' && text) {
          push({ ts, durationMs: 0, lane: 'system', kind: 'system', title: firstLine(text), text: cap(text), sidechain });
        }
        return;
      }
      if (m.type !== 'gemini') return;

      const model = typeof m.model === 'string' ? m.model : undefined;
      if (model) models.add(model);
      const created: TraceEvent[] = [];
      for (const thought of m.thoughts ?? []) {
        const body = [thought.subject, thought.description].filter(Boolean).join('\n').trim();
        created.push(push({
          ts: time(thought.timestamp) || ts, durationMs: 0, lane: 'think', kind: 'thinking', model,
          title: body ? `Thinking: ${firstLine(body)}` : 'Thinking (hidden by the model)',
          text: body ? cap(body) : undefined, sidechain,
        }));
      }
      if (text) created.push(push({ ts, durationMs: 0, lane: 'say', kind: 'text', title: firstLine(text), text: cap(text), model, sidechain }));

      // Tool calls have one timestamp, so the next message marks their end.
      const nextTs = time(messages[index + 1]?.timestamp);
      for (const call of m.toolCalls ?? []) {
        const name = String(call.name);
        const args = call.args ?? {};
        const start = time(call.timestamp) || ts;
        const status = String(call.status ?? '').toLowerCase();
        const output = partsText(call.result);
        const event = push({
          ts: start, durationMs: nextTs > start ? nextTs - start : 0, lane: laneOfTool(name), kind: 'tool',
          title: toolTitle(name, args), sidechain, model,
          tool: {
            name,
            input: cap(JSON.stringify(args, null, 2)),
            output: output ? cap(output) : undefined,
            isError: status === 'error',
            completed: status === 'success' || status === 'error' || status === 'cancelled',
            command: typeof args.command === 'string' ? args.command : undefined,
            file: fileOf(name, args),
          },
        });
        applyDisplay(event, call.resultDisplay);
        created.push(event);
      }

      const tokens = m.tokens;
      if (tokens && created[0]) {
        // Gemini counts cached tokens inside the prompt and bills thoughts as output.
        const cached = Number(tokens.cached) || 0;
        created[0].usage = {
          input: Math.max((Number(tokens.input) || 0) + (Number(tokens.tool) || 0) - cached, 0),
          output: (Number(tokens.output) || 0) + (Number(tokens.thoughts) || 0),
          cacheRead: cached,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
        };
      }
    });
  }

  const finalized = finalizeEvents(events);
  return {
    key: main?.sessionId ?? baseName(paths[0]!).replace(/\.jsonl?$/, ''),
    agent: 'gemini-cli',
    title: firstLine(main?.summary ?? firstPrompt ?? 'Untitled session', 90),
    project: main?.directories?.[0],
    startedAt: finalized[0]?.ts ?? 0,
    endedAt: finalized.length ? Math.max(...finalized.slice(-200).map(e => e.ts + e.durationMs)) : 0,
    models: [...models],
    events: finalized,
  };
}
