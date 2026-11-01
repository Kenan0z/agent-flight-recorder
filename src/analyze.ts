import { cacheRebuildPenalty, costOf, promptTokens, type PriceTable, BUILTIN_PRICES } from './pricing.js';
import { containsSecret } from './redact.js';
import { baseName } from './parsers/common.js';
import type { Analysis, FileStat, Finding, QuotaSample, Session, ToolStat, TraceEvent, Turn } from './types.js';

const CACHE_TTL_MS = 5 * 60_000;
/** Pauses longer than this count as idle rather than working time. */
const IDLE_GAP_MS = 60_000;

const VERIFY_COMMAND = /\b(test|tests|pytest|jest|vitest|mocha|rspec|phpunit|cargo (check|build|clippy)|go (test|build|vet)|tsc|eslint|ruff|mypy|make|gradle|mvn|dotnet (build|test)|npm run (build|lint|check)|pnpm (build|lint)|yarn (build|lint))\b/i;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|ps1|sql|vue|svelte)$/i;

const RISKY_COMMANDS: { re: RegExp; label: string }[] = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|Remove-Item\b.*-Recurse\b.*-Force|Remove-Item\b.*-Force\b.*-Recurse/i, label: 'recursive force delete' },
  { re: /\bgit\s+push\b.*(--force\b|\s-f\b)/i, label: 'force push' },
  { re: /\bgit\s+reset\s+--hard/i, label: 'hard reset' },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, label: 'git clean' },
  { re: /--no-verify\b/, label: 'skipped git hooks' },
  { re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(ba|z)?sh\b|\|\s*iex\b/i, label: 'piped a download into a shell' },
  { re: /\bchmod\s+(-R\s+)?777\b/, label: 'world-writable permissions' },
  { re: /\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i, label: 'destructive SQL' },
  { re: /\bsudo\b/, label: 'sudo' },
];
const SENSITIVE_PATH = /(^|[\\/])(\.env(\.[\w-]+)?|id_rsa|id_ed25519|credentials(\.json)?|\.npmrc|\.netrc|[\w-]+\.pem)$/i;

export function priceEvents(session: Session, table: PriceTable = BUILTIN_PRICES): void {
  for (const e of session.events) {
    if (e.usage) e.costUsd = costOf(e.model, e.usage, table);
  }
}

const money = (n: number) => `$${n.toFixed(2)}`;
const duration = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m >= 1 ? `${m} min` : `${Math.round(ms / 1000)}s`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function costBetween(events: TraceEvent[], from: number, to: number): number {
  let sum = 0;
  for (let i = from; i <= to; i++) sum += events[i]?.costUsd ?? 0;
  return sum;
}

function detectRetryLoops(events: TraceEvent[]): Finding[] {
  const failures = new Map<string, TraceEvent[]>();
  for (const e of events) {
    if (e.tool?.command && e.tool.isError) {
      const key = `${e.sidechain ?? ''}\0${normalizeCommand(e.tool.command)}`;
      failures.set(key, [...(failures.get(key) ?? []), e]);
    }
  }
  const out: Finding[] = [];
  for (const group of failures.values()) {
    if (group.length < 3) continue;
    const spent = costBetween(events, group[0]!.id, group.at(-1)!.id);
    out.push({
      rule: 'retry-loop',
      severity: group.length >= 5 ? 'high' : 'medium',
      title: `The same command failed ${group.length} times`,
      detail: `"${group[0]!.tool!.command!.slice(0, 120)}" kept failing, and about ${money(spent)} was spent between the first and last attempt.`,
      advice: 'When an agent repeats a failure, stop it early and tell it what to try differently.',
      eventIds: group.map(e => e.id),
      wastedUsd: spent,
    });
  }
  return out;
}

function detectErrorStreaks(events: TraceEvent[]): Finding[] {
  const out: Finding[] = [];
  let streak: TraceEvent[] = [];
  const flush = () => {
    if (streak.length >= 5) {
      out.push({
        rule: 'error-streak',
        severity: 'medium',
        title: `${streak.length} actions failed in a row`,
        detail: 'The agent kept going even though nothing it tried was working.',
        advice: 'Check whether it was missing a tool, a permission or a file.',
        eventIds: streak.map(e => e.id),
      });
    }
    streak = [];
  };
  for (const e of events) {
    if (e.kind !== 'tool' || !e.tool?.completed || e.sidechain) continue;
    if (e.tool.isError) streak.push(e);
    else flush();
  }
  flush();
  return out;
}

function detectRedundantReads(events: TraceEvent[]): Finding[] {
  const reads = new Map<string, TraceEvent[]>();
  const flagged = new Map<string, TraceEvent[]>();
  for (const e of events) {
    if (e.kind === 'compact') {
      // Rereading after compaction is expected: the content left the context.
      reads.clear();
      continue;
    }
    const file = e.tool?.file;
    if (!file) continue;
    const key = `${e.sidechain ?? ''}\0${file.path}`;
    if (file.op !== 'read') {
      reads.delete(key);
      continue;
    }
    const list = [...(reads.get(key) ?? []), e];
    reads.set(key, list);
    if (list.length >= 3) flagged.set(key, list);
  }
  return [...flagged.values()].map(list => ({
    rule: 'redundant-read',
    severity: 'low' as const,
    title: `${baseName(list[0]!.tool!.file!.path)} was read ${list.length} times without changing`,
    detail: 'Each read pays again for content the agent had already seen.',
    advice: 'Usually minor, but repeats add up in long sessions.',
    eventIds: list.map(e => e.id),
  }));
}

function detectEditChurn(files: FileStat[]): Finding[] {
  const churned = files.filter(f => f.edits >= 10).sort((a, b) => b.edits - a.edits);
  if (!churned.length) return [];
  const [top] = churned;
  const names = churned.slice(0, 4).map(f => `${baseName(f.path)} (${f.edits})`).join(', ');
  return [{
    rule: 'edit-churn',
    severity: 'low',
    title: churned.length === 1 ? `${baseName(top!.path)} edited ${top!.edits} times` : `${churned.length} files edited 10+ times`,
    detail: `${churned.length > 4 ? `Most edited: ${names}` : names}. This much back and forth often means the approach changed along the way.`,
    advice: 'Review these files more closely than the rest.',
    eventIds: churned.flatMap(f => f.eventIds).sort((a, b) => a - b),
  }];
}

function detectCacheRebuilds(events: TraceEvent[]): Finding[] {
  let previous: TraceEvent | undefined;
  let compactedSince = false;
  const hits: TraceEvent[] = [];
  let wasted = 0;
  let longestGap = 0;
  for (const e of events) {
    if (e.sidechain) continue;
    if (e.kind === 'compact') compactedSince = true;
    if (!e.usage) continue;
    if (previous && !compactedSince) {
      const context = promptTokens(previous.usage!);
      const write = e.usage.cacheWrite5m + e.usage.cacheWrite1h;
      if (context > 5_000 && e.usage.cacheRead < context * 0.1 && write > context * 0.5) {
        hits.push(e);
        wasted += cacheRebuildPenalty(e.model, write) ?? 0;
        longestGap = Math.max(longestGap, e.ts - previous.ts);
      }
    }
    previous = e;
    compactedSince = false;
  }
  if (!hits.length) return [];
  const expired = longestGap > CACHE_TTL_MS;
  return [{
    rule: 'cache-rebuild',
    severity: wasted >= 1 ? 'high' : 'medium',
    title: wasted > 0 ? `Reloading the conversation cost about ${money(wasted)} extra` : `The conversation was reloaded ${times(hits.length)}`,
    detail: expired
      ? `The agent keeps its recent work in a short-lived cache. After a pause of up to ${duration(longestGap)}, it had to load everything again (${times(hits.length)}), which costs more than continuing.`
      : `The agent's short-lived cache stopped matching, so everything was loaded again (${times(hits.length)}), which costs more than continuing.`,
    advice: 'After a long break, consider starting a fresh session instead of continuing a very long one.',
    eventIds: hits.map(e => e.id),
    wastedUsd: wasted,
  }];
}

function detectUnverifiedEdits(events: TraceEvent[]): Finding[] {
  const isCodeEdit = (e: TraceEvent) => e.tool?.file && e.tool.file.op !== 'read' && !e.tool.isError && CODE_FILE.test(e.tool.file.path);
  const edits = events.filter(isCodeEdit);
  if (!edits.length) return [];
  const verifications = events.filter(e => e.tool?.command && VERIFY_COMMAND.test(e.tool.command));
  const lastCheck = verifications.at(-1);
  const after = lastCheck ? edits.filter(e => e.id > lastCheck.id) : edits;
  if (!after.length) return [];
  return [{
    rule: 'unverified-edits',
    severity: 'medium',
    title: lastCheck ? 'Code changed after the last test' : 'Code changed but was never tested',
    detail: lastCheck
      ? `${plural(after.length, 'code edit')} came after the last test, build or lint run, so the final version was not checked.`
      : `${plural(after.length, 'code edit')} were made, and no test, build or lint command ran in this session.`,
    advice: 'Run your tests before trusting this result.',
    eventIds: after.map(e => e.id),
  }];
}

function detectRisk(events: TraceEvent[]): Finding[] {
  const hits = new Map<string, TraceEvent[]>();
  const add = (label: string, e: TraceEvent) => hits.set(label, [...(hits.get(label) ?? []), e]);
  for (const e of events) {
    const command = e.tool?.command;
    if (command) {
      for (const rule of RISKY_COMMANDS) if (rule.re.test(command)) add(rule.label, e);
    }
    if (e.tool?.file?.op === 'read' && SENSITIVE_PATH.test(e.tool.file.path)) add('read a sensitive file', e);
  }
  return [...hits].map(([label, list]) => ({
    rule: 'risky-action',
    severity: 'high' as const,
    title: `Risky action: ${label}`,
    detail: `Happened ${times(list.length)}. It may have been intended.`,
    advice: 'Check what it did and whether you approved it.',
    eventIds: list.map(e => e.id),
  }));
}

function detectSecrets(events: TraceEvent[]): Finding[] {
  const list = events.filter(e => [e.text, e.tool?.input, e.tool?.output].some(t => t && containsSecret(t)));
  if (!list.length) return [];
  return [{
    rule: 'secret-exposure',
    severity: 'high',
    title: `Passwords or keys may be exposed in ${plural(list.length, 'step')}`,
    detail: 'Values that look like credentials appeared in this session, so they were probably sent to the AI provider.',
    advice: 'Check these steps and change any password or key that is real.',
    eventIds: list.map(e => e.id),
  }];
}

function detectExpensiveTurn(turns: Turn[], total: number): Finding[] {
  if (turns.length < 3 || total < 0.5) return [];
  const top = turns.reduce((a, b) => (b.costUsd > a.costUsd ? b : a));
  if (top.costUsd < total * 0.5) return [];
  return [{
    rule: 'expensive-turn',
    severity: 'info',
    title: `One request used ${Math.round((top.costUsd / total) * 100)}% of the cost`,
    detail: `"${top.prompt.slice(0, 80)}" cost ${money(top.costUsd)} out of ${money(total)}.`,
    eventIds: [top.eventId],
  }];
}

interface LimitSummary {
  hits: number;
  retries: number;
  stalledMs: number;
  stopIds: number[];
  findings: Finding[];
}

/** Several limit records in a row are one stop: an agent often logs each failed retry. */
function detectLimits(events: TraceEvent[]): LimitSummary {
  const stops: TraceEvent[][] = [];
  let current: TraceEvent[] | undefined;
  let stalledMs = 0;
  let endedAtLimit = false;
  for (const e of events) {
    if (e.sidechain) continue;
    if (e.limit?.type === 'usage') {
      if (!current) stops.push(current = []);
      current.push(e);
      endedAtLimit = true;
    } else if (current && e.kind !== 'limit') {
      stalledMs += e.ts - current[0]!.ts;
      current = undefined;
      endedAtLimit = false;
    }
  }
  const retryEvents = events.filter(e => e.limit && e.limit.type !== 'usage');
  const findings: Finding[] = [];
  if (stops.length) {
    const last = stops.at(-1)!.at(-1)!;
    const parts = [
      stalledMs > 0 ? `Work stood still for ${duration(stalledMs)} in total.` : '',
      endedAtLimit ? 'The session ended at the limit, so the work may be unfinished.' : '',
      last.text ? `Last message: "${last.text.slice(0, 120)}"` : '',
    ];
    findings.push({
      rule: 'limit-hit',
      severity: 'high',
      title: `A usage limit stopped the work ${times(stops.length)}`,
      detail: parts.filter(Boolean).join(' '),
      advice: 'Plan long tasks around the reset time, or split them into smaller sessions.',
      eventIds: stops.flat().map(e => e.id),
    });
  }
  if (retryEvents.length) {
    const capacity = retryEvents.filter(e => e.limit!.type === 'capacity').length;
    findings.push({
      rule: 'rate-limited',
      severity: retryEvents.length >= 5 ? 'medium' : 'low',
      title: capacity === retryEvents.length
        ? `The AI provider was overloaded ${times(retryEvents.length)}`
        : `Requests were rejected ${times(retryEvents.length)} for being too frequent`,
      detail: capacity === retryEvents.length
        ? 'This comes from the provider being busy, not from your account.'
        : 'This slows a session down, even when the retries succeed.',
      advice: capacity === retryEvents.length ? 'Nothing to fix on your side. Retrying later usually works.' : 'Running fewer agents at once can help.',
      eventIds: retryEvents.map(e => e.id),
    });
  }
  return { hits: stops.length, retries: retryEvents.length, stalledMs, stopIds: stops.map(s => s[0]!.id), findings };
}

function peakQuota(samples: QuotaSample[] = []): QuotaSample[] {
  const peaks = new Map<string, QuotaSample>();
  for (const s of samples) {
    const peak = peaks.get(s.label);
    if (!peak || s.usedPercent >= peak.usedPercent) peaks.set(s.label, s);
  }
  return [...peaks.values()];
}

function detectQuotaPressure(peaks: QuotaSample[], events: TraceEvent[]): Finding[] {
  return peaks.filter(p => p.usedPercent >= 80).map(p => {
    const event = events.find(e => e.ts >= p.ts) ?? events.at(-1);
    const reset = p.resetsAt ? ` It resets at ${new Date(p.resetsAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : '';
    return {
      rule: 'quota-pressure',
      severity: 'medium' as const,
      title: `${Math.round(p.usedPercent)}% of the ${p.label} limit used`,
      detail: `This session came close to the ${p.label} limit.${reset}`,
      advice: 'Leave room for the rest of your work, or wait for the reset before starting something long.',
      eventIds: event ? [event.id] : [],
    };
  });
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

export function analyze(session: Session, table: PriceTable = BUILTIN_PRICES): Analysis {
  priceEvents(session, table);
  const { events } = session;

  const fileMap = new Map<string, FileStat>();
  const toolMap = new Map<string, ToolStat>();
  const turns: Turn[] = [];
  let turn: Turn | undefined;
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, requests = 0, costUsd = 0;
  let toolCalls = 0, toolErrors = 0, compactions = 0;
  let hasUnpricedUsage = false;
  let activeMs = 0, cursor = events[0]?.ts ?? 0;

  for (const e of events) {
    const gap = e.ts - cursor;
    if (gap > 0) activeMs += gap > IDLE_GAP_MS ? 0 : gap;
    cursor = Math.max(cursor, e.ts);
    const end = e.ts + e.durationMs;
    // A pending tool can be waiting for a person, so only short calls count as work.
    if (end > cursor) {
      if (end - cursor <= IDLE_GAP_MS * 10) activeMs += end - cursor;
      cursor = end;
    }

    if (e.kind === 'prompt' && !e.sidechain) {
      turn = { index: turns.length, eventId: e.id, prompt: e.title, startTs: e.ts, endTs: e.ts, costUsd: 0, tokens: 0, tools: 0, errors: 0 };
      turns.push(turn);
    }
    if (turn) turn.endTs = Math.max(turn.endTs, end);
    if (e.kind === 'compact') compactions++;

    if (e.usage) {
      requests++;
      input += e.usage.input;
      output += e.usage.output;
      cacheRead += e.usage.cacheRead;
      cacheWrite += e.usage.cacheWrite5m + e.usage.cacheWrite1h;
      if (e.costUsd === undefined) hasUnpricedUsage = true;
      costUsd += e.costUsd ?? 0;
      if (turn) {
        turn.costUsd += e.costUsd ?? 0;
        turn.tokens += promptTokens(e.usage) + e.usage.output;
      }
    }

    const tool = e.tool;
    if (!tool) continue;
    toolCalls++;
    if (tool.isError) toolErrors++;
    if (turn) {
      turn.tools++;
      if (tool.isError) turn.errors++;
    }
    const stat = toolMap.get(tool.name) ?? { name: tool.name, count: 0, errors: 0, totalMs: 0 };
    stat.count++;
    stat.totalMs += e.durationMs;
    if (tool.isError) stat.errors++;
    toolMap.set(tool.name, stat);

    if (tool.file && !tool.isError) {
      const f = fileMap.get(tool.file.path) ?? { path: tool.file.path, reads: 0, edits: 0, added: 0, removed: 0, eventIds: [] };
      if (tool.file.op === 'read') f.reads++;
      else {
        f.edits++;
        f.added += tool.file.added;
        f.removed += tool.file.removed;
      }
      f.eventIds.push(e.id);
      fileMap.set(tool.file.path, f);
    }
  }

  const files = [...fileMap.values()].sort((a, b) => b.edits - a.edits || b.added + b.removed - a.added - a.removed || b.reads - a.reads);
  const tools = [...toolMap.values()].sort((a, b) => b.count - a.count);
  const changed = files.filter(f => f.edits > 0);

  const limits = detectLimits(events);
  const quota = peakQuota(session.quota);

  const findings = [
    ...limits.findings,
    ...detectQuotaPressure(quota, events),
    ...detectSecrets(events),
    ...detectRisk(events),
    ...detectRetryLoops(events),
    ...detectCacheRebuilds(events),
    ...detectErrorStreaks(events),
    ...detectUnverifiedEdits(events),
    ...detectRedundantReads(events),
    ...detectEditChurn(files),
    ...detectExpensiveTurn(turns, costUsd),
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (b.wastedUsd ?? 0) - (a.wastedUsd ?? 0));

  const promptTotal = input + cacheRead + cacheWrite;
  return {
    totals: {
      costUsd,
      hasUnpricedUsage,
      input,
      output,
      cacheRead,
      cacheWrite,
      cacheHitRate: promptTotal ? cacheRead / promptTotal : 0,
      requests,
      toolCalls,
      toolErrors,
      filesChanged: changed.length,
      linesAdded: changed.reduce((n, f) => n + f.added, 0),
      linesRemoved: changed.reduce((n, f) => n + f.removed, 0),
      wallMs: session.endedAt - session.startedAt,
      activeMs,
      compactions,
      // Retry-loop spend can overlap a cache rebuild, so never claim more than was spent.
      wastedUsd: Math.min(findings.reduce((n, f) => n + (f.wastedUsd ?? 0), 0), costUsd),
      limitHits: limits.hits,
      limitRetries: limits.retries,
      stalledMs: limits.stalledMs,
    },
    quota,
    limitStops: limits.stopIds,
    turns,
    files,
    tools,
    findings,
  };
}
