import { baseName, cap, classifyLimit, epochMs, finalizeEvents, firstLine, laneOfTool, readJsonl, resetFromText, time } from './common.js';
import type { FileTouch, LimitType, QuotaSample, Session, TraceEvent } from '../types.js';

function windowLabel(minutes: unknown, fallback: string): string {
  const m = Number(minutes);
  if (!m) return fallback;
  if (m === 10080) return 'weekly';
  if (m % 1440 === 0) return `${m / 1440}-day`;
  if (m % 60 === 0) return `${m / 60}-hour`;
  return `${m}-minute`;
}

/** `codex_error_info` is a string or a one-key object. Spelling varies by version. */
function limitFromErrorInfo(info: unknown): LimitType | undefined {
  const raw = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
  const name = raw?.replaceAll('_', '').toLowerCase();
  if (name === 'usagelimitexceeded' || name === 'sessionbudgetexceeded') return 'usage';
  if (name === 'ratelimitexceeded') return 'rate';
  if (name === 'serveroverloaded') return 'capacity';
  return undefined;
}

function parseArgs(raw: unknown): any {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function commandOf(args: any): string | undefined {
  const command = args?.command ?? args?.cmd;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) {
    // Codex wraps commands as ["bash", "-lc", "<script>"].
    if (command.length === 3 && /^-\w*c$/.test(String(command[1]))) return String(command[2]);
    return command.join(' ');
  }
  return undefined;
}

function touchFromPatch(patch: string): { file?: FileTouch; diff?: string } {
  const path = patch.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m)?.[1]?.trim();
  if (!path) return {};
  const lines = patch.split('\n');
  return {
    diff: cap(patch),
    file: {
      path,
      op: /^\*\*\* Add File:/m.test(patch) ? 'create' : 'edit',
      added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
      removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
    },
  };
}

function outputText(raw: unknown): { text: string; isError: boolean } {
  let value: any = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { value = raw; }
  }
  if (typeof value === 'string') {
    const exit = value.match(/(?:exit code|exit_code)["':\s]+(-?\d+)/i)?.[1];
    return { text: value, isError: exit !== undefined && exit !== '0' };
  }
  if (Array.isArray(value)) {
    return { text: value.map(b => b?.text ?? '').filter(Boolean).join('\n'), isError: false };
  }
  const exit = value?.metadata?.exit_code ?? value?.exit_code;
  const text = typeof value?.output === 'string' ? value.output : JSON.stringify(value);
  return { text, isError: value?.success === false || (exit !== undefined && exit !== 0) };
}

export async function parseCodex(path: string): Promise<Session> {
  const events: TraceEvent[] = [];
  const pending = new Map<string, TraceEvent>();
  const models = new Set<string>();
  let model: string | undefined;
  let key = baseName(path).replace(/\.jsonl$/, '');
  let project: string | undefined;
  let branch: string | undefined;
  let version: string | undefined;
  let firstPrompt: string | undefined;
  let lastTotal = -1;
  const quota: QuotaSample[] = [];
  const lastPercent = new Map<string, number>();

  const push = (e: Omit<TraceEvent, 'id'>): TraceEvent => {
    const event = { id: 0, ...e };
    events.push(event);
    return event;
  };

  const addTool = (ts: number, name: string, args: any, callId: unknown, patchText?: string) => {
    const command = commandOf(args);
    const patch = patchText ?? (typeof args?.patch === 'string' ? args.patch : typeof args?.input === 'string' ? args.input : undefined);
    const touch = patch && name === 'apply_patch' ? touchFromPatch(patch) : {};
    const label = command ?? touch.file?.path ?? (typeof args?.query === 'string' ? args.query : '');
    const event = push({
      ts, durationMs: 0, lane: laneOfTool(name), kind: 'tool', model,
      title: label ? `${name}: ${firstLine(touch.file ? baseName(label) : label)}` : name,
      tool: {
        name, command, isError: false, completed: false,
        input: cap(patchText ?? JSON.stringify(args, null, 2)),
        file: touch.file, diff: touch.diff,
      },
    });
    if (callId) pending.set(String(callId), event);
  };

  const finishTool = (ts: number, callId: unknown, output: unknown) => {
    const event = pending.get(String(callId));
    if (!event) return;
    pending.delete(String(callId));
    const { text, isError } = outputText(output);
    event.durationMs = Math.max(ts - event.ts, 0);
    event.tool!.completed = true;
    event.tool!.isError = isError;
    if (text) event.tool!.output = cap(text);
  };

  for await (const o of readJsonl(path)) {
    const ts = time(o.timestamp);
    const p = o.payload ?? {};

    if (o.type === 'session_meta') {
      key = p.id ? String(p.id) : key;
      project = p.cwd ?? project;
      branch = p.git?.branch ?? branch;
      version = p.cli_version ?? version;
      continue;
    }
    if (o.type === 'turn_context') {
      if (p.model) { model = String(p.model); models.add(model); }
      project ??= p.cwd;
      continue;
    }
    if (!ts) continue;

    if (o.type === 'event_msg' && (p.type === 'error' || p.type === 'stream_error')) {
      const text = [p.message, p.additional_details].filter(Boolean).join('\n');
      const type = limitFromErrorInfo(p.codex_error_info) ?? classifyLimit(text);
      if (type) {
        push({
          ts, durationMs: 0, lane: 'limit', kind: 'limit', title: firstLine(text || 'Limit reached'), text: cap(text),
          limit: { type, resetsAt: resetFromText(text, ts) },
        });
      } else if (p.type === 'error') {
        // stream_error is a retry notice, so only a final error belongs on the timeline.
        push({ ts, durationMs: 0, lane: 'system', kind: 'system', title: firstLine(text || 'Error'), text: cap(text) });
      }
      continue;
    }

    if (o.type === 'event_msg' && p.type === 'token_count' && p.rate_limits) {
      const limits = p.rate_limits;
      for (const [slot, window] of [['primary', limits.primary], ['secondary', limits.secondary]] as const) {
        if (typeof window?.used_percent !== 'number') continue;
        const label = windowLabel(window.window_minutes, slot);
        if (lastPercent.get(label) === window.used_percent) continue;
        lastPercent.set(label, window.used_percent);
        quota.push({ ts, label, usedPercent: window.used_percent, resetsAt: epochMs(window.resets_at) });
      }
      if (limits.rate_limit_reached_type && !events.at(-1)?.limit) {
        const text = `Limit reached: ${String(limits.rate_limit_reached_type).replaceAll('_', ' ')}`;
        push({ ts, durationMs: 0, lane: 'limit', kind: 'limit', title: text, text, limit: { type: 'usage' } });
      }
    }

    if (o.type === 'event_msg' && p.type === 'token_count' && p.info?.last_token_usage) {
      // The CLI re-emits the same counter, so only a growing total is a new request.
      const total = Number(p.info.total_token_usage?.total_tokens) || 0;
      if (total === lastTotal) continue;
      lastTotal = total;
      const u = p.info.last_token_usage;
      const cached = Number(u.cached_input_tokens) || 0;
      const target = events.findLast(e => e.kind !== 'prompt' && e.kind !== 'limit' && e.kind !== 'system' && !e.usage);
      if (target) {
        target.usage = {
          input: Math.max((Number(u.input_tokens) || 0) - cached, 0),
          output: Number(u.output_tokens) || 0,
          cacheRead: cached,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
        };
      }
      continue;
    }
    if (o.type !== 'response_item') continue;

    switch (p.type) {
      case 'message': {
        const text = (Array.isArray(p.content) ? p.content : [])
          .map((b: any) => b?.text ?? '')
          .join('\n')
          .trim();
        if (!text) break;
        if (p.role === 'user') {
          // Codex injects environment context as user messages.
          if (/^<(environment_context|user_instructions|permissions)/.test(text)) break;
          firstPrompt ??= text;
          push({ ts, durationMs: 0, lane: 'prompt', kind: 'prompt', title: firstLine(text), text: cap(text) });
        } else if (p.role === 'assistant') {
          push({ ts, durationMs: 0, lane: 'say', kind: 'text', title: firstLine(text), text: cap(text), model });
        }
        break;
      }
      case 'reasoning': {
        const text = (Array.isArray(p.summary) ? p.summary : []).map((b: any) => b?.text ?? '').join('\n').trim();
        push({
          ts, durationMs: 0, lane: 'think', kind: 'thinking', model,
          title: text ? `Thinking: ${firstLine(text)}` : 'Thinking (hidden by the model)',
          text: text ? cap(text) : undefined,
        });
        break;
      }
      case 'function_call':
        addTool(ts, String(p.name), parseArgs(p.arguments), p.call_id);
        break;
      case 'custom_tool_call':
        addTool(ts, String(p.name), typeof p.input === 'string' ? { input: p.input } : p.input, p.call_id, typeof p.input === 'string' ? p.input : undefined);
        break;
      case 'local_shell_call':
        addTool(ts, 'shell', p.action ?? {}, p.call_id);
        break;
      case 'web_search_call':
        addTool(ts, 'web_search', p.action ?? {}, undefined);
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
        finishTool(ts, p.call_id, p.output);
        break;
    }
  }

  const finalized = finalizeEvents(events);
  return {
    key,
    agent: 'codex',
    title: firstLine(firstPrompt ?? 'Untitled session', 90),
    project,
    branch,
    agentVersion: version,
    startedAt: finalized[0]?.ts ?? 0,
    endedAt: finalized.length ? Math.max(...finalized.slice(-200).map(e => e.ts + e.durationMs)) : 0,
    models: [...models],
    events: finalized,
    quota: quota.length ? quota : undefined,
  };
}
