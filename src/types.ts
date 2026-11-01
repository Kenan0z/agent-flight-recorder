export type AgentKind = 'claude-code' | 'codex' | 'gemini-cli';

/** Horizontal track on the timeline. */
export type Lane =
  | 'prompt' | 'think' | 'say' | 'read' | 'write'
  | 'shell' | 'search' | 'web' | 'agent' | 'mcp' | 'other' | 'limit' | 'system';

/**
 * usage: a plan or quota allowance ran out, so work stops until it resets.
 * rate: a short-term request limit, usually retried.
 * capacity: the provider was overloaded, which says nothing about the account.
 */
export type LimitType = 'usage' | 'rate' | 'capacity';

export interface LimitInfo {
  type: LimitType;
  /** The agent's own name for the window, such as "five hour". */
  scope?: string;
  resetsAt?: number;
  status?: number;
}

/** How much of a limit window was used at one moment, when the agent logs it. */
export interface QuotaSample {
  ts: number;
  label: string;
  usedPercent: number;
  resetsAt?: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  fast?: boolean;
}

export interface FileTouch {
  path: string;
  op: 'read' | 'edit' | 'create';
  added: number;
  removed: number;
}

export interface ToolCall {
  name: string;
  input?: string;
  output?: string;
  isError: boolean;
  /** False when the log ends before the tool returned. */
  completed: boolean;
  command?: string;
  diff?: string;
  file?: FileTouch;
}

export interface TraceEvent {
  /** Index into Session.events, assigned after sorting by time. */
  id: number;
  ts: number;
  durationMs: number;
  lane: Lane;
  kind: 'prompt' | 'thinking' | 'text' | 'tool' | 'compact' | 'limit' | 'system';
  title: string;
  text?: string;
  /** Subagent id when the event ran outside the main thread. */
  sidechain?: string;
  model?: string;
  /** Usage of the API response that produced this event. Set once per response. */
  usage?: Usage;
  costUsd?: number;
  tool?: ToolCall;
  compact?: { trigger?: string; preTokens?: number; postTokens?: number };
  limit?: LimitInfo;
}

export interface Session {
  key: string;
  agent: AgentKind;
  title: string;
  project?: string;
  branch?: string;
  agentVersion?: string;
  startedAt: number;
  endedAt: number;
  models: string[];
  events: TraceEvent[];
  quota?: QuotaSample[];
}

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  /** What the reader can do about it, in plain language. */
  advice?: string;
  eventIds: number[];
  /** Estimated avoidable spend, when it can be attributed. */
  wastedUsd?: number;
}

export interface Turn {
  index: number;
  eventId: number;
  prompt: string;
  startTs: number;
  endTs: number;
  costUsd: number;
  tokens: number;
  tools: number;
  errors: number;
}

export interface FileStat {
  path: string;
  reads: number;
  edits: number;
  added: number;
  removed: number;
  eventIds: number[];
}

export interface ToolStat {
  name: string;
  count: number;
  errors: number;
  totalMs: number;
}

export interface Totals {
  costUsd: number;
  /** True if at least one response used a model without a known price. */
  hasUnpricedUsage: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitRate: number;
  requests: number;
  toolCalls: number;
  toolErrors: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  wallMs: number;
  activeMs: number;
  compactions: number;
  wastedUsd: number;
  /** Separate times a usage limit stopped the work. */
  limitHits: number;
  /** Rate-limit and overload errors. */
  limitRetries: number;
  /** Time between hitting a usage limit and work resuming. */
  stalledMs: number;
}

export interface Analysis {
  /** Highest use seen per limit window. */
  quota: QuotaSample[];
  /** First event of each stop caused by a usage limit. */
  limitStops: number[];
  totals: Totals;
  turns: Turn[];
  files: FileStat[];
  tools: ToolStat[];
  findings: Finding[];
}

/** Lightweight row for the session list. Cached on disk between runs. */
export interface SessionSummary {
  key: string;
  agent: AgentKind;
  title: string;
  project?: string;
  branch?: string;
  startedAt: number;
  endedAt: number;
  costUsd: number;
  hasUnpricedUsage: boolean;
  tokens: number;
  toolCalls: number;
  toolErrors: number;
  filesChanged: number;
  findings: number;
  highFindings: number;
  wastedUsd: number;
  limitHits: number;
  limitStops: { ts: number; scope?: string; resetsAt?: number }[];
  /** Estimated cost per local calendar day (YYYY-MM-DD), including days with no priced usage. */
  daily: Record<string, number>;
  modelCosts: Record<string, number>;
  topFinding?: string;
}
