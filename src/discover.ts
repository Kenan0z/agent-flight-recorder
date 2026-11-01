import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { analyze } from './analyze.js';
import { parseClaude } from './parsers/claude.js';
import { parseCodex } from './parsers/codex.js';
import { readJsonl } from './parsers/common.js';
import { parseGemini } from './parsers/gemini.js';
import type { PriceTable } from './pricing.js';
import type { Analysis, AgentKind, Session, SessionSummary } from './types.js';

export interface LogSource {
  agent: AgentKind;
  /** Main log first, then any subagent logs. */
  paths: string[];
}

function walk(dir: string, visit: (path: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.isFile() && (entry.name.endsWith('.jsonl') || LEGACY_GEMINI.test(entry.name))) visit(path);
  }
}

/** Older Gemini CLI versions wrote one JSON document per session. */
const LEGACY_GEMINI = /^session-.*\.json$/;

async function sniffAgent(path: string): Promise<AgentKind | undefined> {
  if (LEGACY_GEMINI.test(basename(path))) return 'gemini-cli';
  let checked = 0;
  for await (const o of readJsonl(path)) {
    if (o.projectHash) return 'gemini-cli';
    if (o.payload && /^(session_meta|response_item|event_msg|turn_context)$/.test(o.type)) return 'codex';
    if (o.sessionId || o.message) return 'claude-code';
    if (++checked > 50) break;
  }
  return undefined;
}

/** Scans a tree of logs, attaching <id>/subagents/*.jsonl to their parent <id>.jsonl. */
export async function scanTree(root: string, known?: AgentKind): Promise<LogSource[]> {
  const stat = statSync(root, { throwIfNoEntry: false });
  if (!stat) return [];
  const mains: string[] = [];
  const subagents = new Map<string, string[]>();
  const add = (path: string) => {
    const parent = dirname(path);
    if (basename(parent) === 'subagents') {
      const owner = `${dirname(parent)}.jsonl`;
      subagents.set(owner, [...(subagents.get(owner) ?? []), path]);
    } else {
      mains.push(path);
    }
  };
  if (stat.isFile()) add(root);
  else walk(root, add);

  const sources: LogSource[] = [];
  for (const main of mains) {
    const agent = known ?? await sniffAgent(main);
    if (agent) sources.push({ agent, paths: [main, ...(subagents.get(main) ?? [])] });
  }
  return sources;
}

/** Layout: tmp/<project>/chats/session-<time>-<id8>.jsonl with subagents in chats/<sessionId>/. */
function scanGemini(root: string): LogSource[] {
  const sources: LogSource[] = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return [];
  }
  for (const project of projects) {
    const chats = join(root, project, 'chats');
    let entries;
    try {
      entries = readdirSync(chats, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = new Set(entries.map(e => e.name));
    const subagentDirs = entries.filter(e => e.isDirectory());
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('session-')) continue;
      // A migrated session keeps both files. The .jsonl one is current.
      if (entry.name.endsWith('.json') && names.has(`${entry.name}l`)) continue;
      if (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.json')) continue;
      const shortId = entry.name.replace(/\.jsonl?$/, '').split('-').pop();
      const paths = [join(chats, entry.name)];
      for (const dir of subagentDirs) {
        if (dir.name.slice(0, 8) !== shortId) continue;
        for (const file of readdirSync(join(chats, dir.name))) {
          if (file.endsWith('.jsonl')) paths.push(join(chats, dir.name, file));
        }
      }
      sources.push({ agent: 'gemini-cli', paths });
    }
  }
  return sources;
}

export async function discover(extraDirs: string[] = []): Promise<LogSource[]> {
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const codexRoot = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const found = [
    ...await scanTree(join(claudeRoot, 'projects'), 'claude-code'),
    ...await scanTree(join(codexRoot, 'sessions'), 'codex'),
    ...scanGemini(join(process.env.GEMINI_CLI_HOME ?? homedir(), '.gemini', 'tmp')),
  ];
  for (const dir of extraDirs) found.push(...await scanTree(dir));
  return found;
}

export async function loadSession(source: LogSource): Promise<Session> {
  if (source.agent === 'codex') return parseCodex(source.paths[0]!);
  if (source.agent === 'gemini-cli') return parseGemini(source.paths);
  return parseClaude(source.paths);
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function summarize(session: Session, analysis: Analysis): SessionSummary {
  const t = analysis.totals;
  const daily: Record<string, number> = {};
  const modelCosts: Record<string, number> = {};
  for (const e of session.events) {
    const day = dayKey(e.ts);
    daily[day] = (daily[day] ?? 0) + (e.costUsd ?? 0);
    if (e.usage && e.model) modelCosts[e.model] = (modelCosts[e.model] ?? 0) + (e.costUsd ?? 0);
  }
  return {
    daily,
    modelCosts,
    limitStops: analysis.limitStops.map(id => {
      const e = session.events[id]!;
      return { ts: e.ts, scope: e.limit?.scope, resetsAt: e.limit?.resetsAt };
    }),
    topFinding: analysis.findings[0]?.title,
    key: session.key,
    agent: session.agent,
    title: session.title,
    project: session.project,
    branch: session.branch,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    costUsd: t.costUsd,
    hasUnpricedUsage: t.hasUnpricedUsage,
    tokens: t.input + t.output + t.cacheRead + t.cacheWrite,
    toolCalls: t.toolCalls,
    toolErrors: t.toolErrors,
    filesChanged: t.filesChanged,
    findings: analysis.findings.length,
    highFindings: analysis.findings.filter(f => f.severity === 'high').length,
    wastedUsd: t.wastedUsd,
    limitHits: t.limitHits,
  };
}

interface CacheEntry {
  fingerprint: string;
  summary: SessionSummary | null;
}

const INDEX_VERSION = 3;

function indexPath(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(base, 'agent-flightrec', `index-v${INDEX_VERSION}.json`);
}

function fingerprint(source: LogSource): string {
  return source.paths.map(p => {
    const s = statSync(p, { throwIfNoEntry: false });
    return s ? `${s.size}:${Math.floor(s.mtimeMs)}` : 'gone';
  }).join('|');
}

export interface IndexedSession {
  source: LogSource;
  summary: SessionSummary;
}

/**
 * Parses every log once and reuses the result until the file changes, so
 * listing stays fast with gigabytes of history.
 */
export async function buildIndex(
  sources: LogSource[],
  options: { prices?: PriceTable; useCache?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<IndexedSession[]> {
  const useCache = options.useCache !== false && !options.prices;
  let cache: Record<string, CacheEntry> = {};
  if (useCache) {
    try {
      cache = JSON.parse(readFileSync(indexPath(), 'utf8'));
    } catch {
      cache = {};
    }
  }
  const next: Record<string, CacheEntry> = {};
  const indexed: IndexedSession[] = [];
  let done = 0;
  for (const source of sources) {
    const id = source.paths[0]!;
    const print = fingerprint(source);
    let summary = cache[id]?.fingerprint === print ? cache[id]!.summary : undefined;
    if (summary === undefined) {
      try {
        const session = await loadSession(source);
        summary = session.events.length ? summarize(session, analyze(session, options.prices)) : null;
      } catch {
        // One unreadable log should not hide the others.
        summary = null;
      }
    }
    next[id] = { fingerprint: print, summary };
    if (summary) indexed.push({ source, summary });
    options.onProgress?.(++done, sources.length);
  }
  if (useCache) {
    try {
      mkdirSync(dirname(indexPath()), { recursive: true });
      writeFileSync(indexPath(), JSON.stringify(next));
    } catch {
      // The cache only saves time.
    }
  }
  return indexed.sort((a, b) => b.summary.endedAt - a.summary.endedAt);
}
