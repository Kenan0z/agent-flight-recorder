import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Lane, LimitType, TraceEvent } from '../types.js';

export const MAX_TEXT = 12_000;

export function cap(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${(text.length - max).toLocaleString('en-US')} more characters in the log]`;
}

export function firstLine(text: string, max = 110): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export function time(value: unknown): number {
  const t = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Yields parsed lines one at a time so logs of hundreds of MB stay out of
 * memory. Malformed lines are skipped because a running agent may still be
 * writing the last one. `skip` looks at the raw line to avoid parsing noise.
 */
export async function* readJsonl(path: string, skip?: (line: string) => boolean): AsyncGenerator<any> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || skip?.(line)) continue;
    try {
      yield JSON.parse(line);
    } catch {
      continue;
    }
  }
}

export function laneOfTool(name: string): Lane {
  if (name.startsWith('mcp__')) return 'mcp';
  if (/^(Read|NotebookRead|read_file|read_many_files|view_image)$/i.test(name)) return 'read';
  if (/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|write_file|replace)$/i.test(name)) return 'write';
  if (/^(Bash|PowerShell|BashOutput|KillShell|KillBash|Monitor|TaskStop|TaskOutput|shell|shell_command|local_shell|local_shell_call|exec_command|write_stdin|run_shell_command)$/i.test(name)) return 'shell';
  if (/^(Grep|Glob|LS|ToolSearch|grep_files|list_dir|list_directory|search_file_content|grep_search)$/i.test(name)) return 'search';
  if (/^(WebSearch|WebFetch|web_search|web_search_call|web_fetch|google_web_search)$/i.test(name)) return 'web';
  if (/^(Agent|Task|spawn_agent|delegate_to_agent)$/i.test(name)) return 'agent';
  return 'other';
}

export function toolTitle(name: string, input: any): string {
  const path = input?.file_path ?? input?.notebook_path ?? input?.absolute_path ?? input?.path;
  const label = typeof input?.command === 'string' ? input.command
    : typeof input?.pattern === 'string' ? input.pattern
    : typeof input?.query === 'string' ? input.query
    : typeof input?.url === 'string' ? input.url
    : typeof input?.description === 'string' ? input.description
    : typeof input?.skill === 'string' ? input.skill
    : typeof path === 'string' ? baseName(path)
    : '';
  const short = name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name;
  return label ? `${short}: ${firstLine(label)}` : short;
}

/** Recognizes limit errors from their wording, which each agent words differently. */
export function classifyLimit(text: string, status?: number): LimitType | undefined {
  if (status === 529 || status === 503 || /model_capacity|no capacity|at capacity|overloaded/i.test(text)) return 'capacity';
  if (/(usage|session|daily|weekly|monthly|plan|spend(ing)?|credit) limit|per.?day|hit your .*limit|reached your .*limit|exhausted your/i.test(text)) return 'usage';
  if (status === 429 || /rate.?limit|too many requests|resource.{0,10}exhausted|\b429\b/i.test(text)) return 'rate';
  if (/\bquota\b/i.test(text)) return 'usage';
  return undefined;
}

/** Reads wording such as "reset after 5h3m20s" into a timestamp. */
export function resetFromText(text: string, now: number): number | undefined {
  const match = text.match(/(?:reset|resets|retry)\s+(?:after|in)\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (!match || !(match[1] || match[2] || match[3])) return undefined;
  return now + (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000;
}

/** Agents log reset times in seconds or milliseconds since the epoch. */
export function epochMs(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

/** Sorts by time, keeping log order for ties, and assigns final ids. */
export function finalizeEvents(events: TraceEvent[]): TraceEvent[] {
  const sorted = events
    .map((e, i) => [e, i] as const)
    .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
    .map(([e]) => e);
  sorted.forEach((e, i) => { e.id = i; });
  return sorted;
}
