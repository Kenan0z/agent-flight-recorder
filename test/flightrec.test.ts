import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { analyze } from '../src/analyze.js';
import { buildIndex, discover, scanTree } from '../src/discover.js';
import { PACKAGE_ROOT, renderExport } from '../src/export.js';
import { parseClaude } from '../src/parsers/claude.js';
import { parseCodex } from '../src/parsers/codex.js';
import { classifyLimit, resetFromText } from '../src/parsers/common.js';
import { parseGemini } from '../src/parsers/gemini.js';
import { costOf, findPrice } from '../src/pricing.js';
import { containsSecret, redactSecrets, redactSession } from '../src/redact.js';
import { createAppServer } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'flightrec-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function writeLog(records: unknown[]): string {
  const path = join(dir, `log-${++counter}.jsonl`);
  writeFileSync(path, records.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return path;
}

const demoDir = join(PACKAGE_ROOT, 'fixtures', 'demo');
const demoPath = join(demoDir, 'demo-session.jsonl');
const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();

test('claude: counts usage once when a response spans several records', async () => {
  const session = await parseClaude([writeLog([
    { type: 'user', uuid: 'a', timestamp: at(0), message: { content: 'hello' } },
    { type: 'assistant', uuid: 'b', timestamp: at(1), message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }], usage: { ...usage, output_tokens: 5 } } },
    { type: 'assistant', uuid: 'c', timestamp: at(2), message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } }], usage } },
  ])]);
  const withUsage = session.events.filter(e => e.usage);
  assert.equal(withUsage.length, 1);
  assert.equal(withUsage[0]!.usage!.output, 100, 'keeps the final usage value');
  assert.equal(analyze(session).totals.requests, 1);
});

test('claude: pairs tool results, duration, errors and diffs', async () => {
  const session = await parseClaude([writeLog([
    { type: 'assistant', uuid: 'a', timestamp: at(0), message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], usage } },
    { type: 'user', uuid: 'b', timestamp: at(9), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] } },
    { type: 'assistant', uuid: 'c', timestamp: at(10), message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y\nz' } }], usage } },
    { type: 'user', uuid: 'd', timestamp: at(11), toolUseResult: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-x', '+y', '+z'] }] }, message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
    { type: 'assistant', uuid: 'e', timestamp: at(12), message: { id: 'm3', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'sleep 99' } }], usage } },
  ])]);
  const [bash, edit, pending] = session.events;
  assert.equal(bash!.durationMs, 9000);
  assert.equal(bash!.tool!.isError, true);
  assert.equal(bash!.tool!.output, 'boom');
  assert.deepEqual([edit!.tool!.file!.added, edit!.tool!.file!.removed], [2, 1]);
  assert.match(edit!.tool!.diff!, /@@ -1,1 \+1,2 @@/);
  assert.equal(pending!.tool!.completed, false);
});

test('claude: survives malformed lines, replays and hidden thinking, strips injected tags', async () => {
  const record = { type: 'assistant', uuid: 'same', timestamp: at(1), message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '' }], usage } };
  const session = await parseClaude([writeLog([
    '{"type":"user", broken',
    { type: 'user', uuid: 'p', timestamp: at(0), message: { content: 'Real question<system-reminder>injected text</system-reminder>' } },
    { type: 'user', uuid: 'q', timestamp: at(0), isMeta: true, message: { content: 'meta' } },
    { type: 'mystery-record', foo: 1 },
    record,
    record,
  ])]);
  assert.equal(session.events.length, 2);
  assert.equal(session.events[0]!.text, 'Real question');
  assert.match(session.events[1]!.title, /hidden/);
  assert.equal(session.title, 'Real question');
});

test('codex: parses a rollout with tools, patches and token counts', async () => {
  const line = (seconds: number, type: string, payload: unknown) => ({ timestamp: at(seconds), type, payload });
  const usageMsg = (total: number) => line(4, 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } } });
  const session = await parseCodex(writeLog([
    line(0, 'session_meta', { id: 'codex-1', cwd: '/work', cli_version: '1.0', git: { branch: 'main' } }),
    line(0, 'turn_context', { model: 'gpt-x', cwd: '/work' }),
    line(0, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] }),
    line(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix it' }] }),
    line(2, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) }),
    line(3, 'response_item', { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'fail', metadata: { exit_code: 1 } }) }),
    usageMsg(1050),
    usageMsg(1050),
    line(5, 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n+more\n*** End Patch' }),
    line(6, 'response_item', { type: 'custom_tool_call_output', call_id: 'c2', output: 'Done' }),
  ]));
  assert.equal(session.key, 'codex-1');
  assert.equal(session.branch, 'main');
  assert.equal(session.title, 'Fix it');
  const shell = session.events.find(e => e.tool?.name === 'shell')!;
  assert.equal(shell.tool!.command, 'npm test');
  assert.equal(shell.tool!.isError, true);
  assert.equal(shell.usage!.cacheRead, 800);
  assert.equal(shell.usage!.input, 200);
  const patch = session.events.find(e => e.tool?.name === 'apply_patch')!;
  assert.deepEqual(patch.tool!.file, { path: 'src/a.ts', op: 'edit', added: 2, removed: 1 });
  const totals = analyze(session).totals;
  assert.equal(totals.requests, 1, 'duplicate token_count ignored');
  assert.equal(totals.hasUnpricedUsage, true, 'never guesses a price for an unknown model');
});

test('limits: classifies wording from different agents', () => {
  assert.equal(classifyLimit("You've hit your session limit · resets 1:50am"), 'usage');
  assert.equal(classifyLimit('Quota exceeded for quota metric, limit per day per user'), 'usage');
  assert.equal(classifyLimit('Resource has been exhausted (e.g. check quota).'), 'rate');
  assert.equal(classifyLimit('429 Too Many Requests'), 'rate');
  assert.equal(classifyLimit('MODEL_CAPACITY_EXHAUSTED'), 'capacity');
  assert.equal(classifyLimit('anything', 529), 'capacity');
  assert.equal(classifyLimit('File not found: quotas.ts'), undefined);
  assert.equal(classifyLimit('Could not read the file'), undefined);
  assert.equal(resetFromText('Your quota will reset after 1h2m3s.', 1000), 1000 + 3723_000);
  assert.equal(resetFromText('no time here', 1000), undefined);
});

test('claude: turns limit records into one stop and measures the stall', async () => {
  const limitRecord = (uuid: string, seconds: number) => ({
    type: 'assistant', uuid, timestamp: at(seconds), isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
    quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_800_000_000 },
    message: { id: uuid, model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }], usage: { input_tokens: 0, output_tokens: 0 } },
  });
  const session = await parseClaude([writeLog([
    { type: 'user', uuid: 'a', timestamp: at(0), message: { content: 'Work' } },
    limitRecord('b', 10),
    limitRecord('c', 20),
    { type: 'assistant', uuid: 'n', timestamp: at(25), isApiErrorMessage: true, message: { id: 'n', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
    { type: 'user', uuid: 'd', timestamp: at(50), message: { content: 'Continue' } },
  ])]);
  const limits = session.events.filter(e => e.kind === 'limit');
  assert.equal(limits.length, 2);
  assert.deepEqual(limits[0]!.limit, { type: 'usage', status: 429, scope: 'five hour', resetsAt: 1_800_000_000_000 });
  assert.equal(session.events.some(e => e.title.includes('No response')), false);
  const analysis = analyze(session);
  assert.equal(analysis.totals.limitHits, 1, 'consecutive records are one stop');
  assert.equal(analysis.totals.stalledMs, 40_000);
  assert.equal(analysis.totals.requests, 0, 'synthetic records are not requests');
  assert.ok(analysis.findings.some(f => f.rule === 'limit-hit' && f.severity === 'high'));
});

test('codex: reads quota windows and usage limit errors', async () => {
  const line = (seconds: number, type: string, payload: unknown) => ({ timestamp: at(seconds), type, payload });
  const window = (used: number, minutes: number) => ({ used_percent: used, window_minutes: minutes, resets_at: 1_800_000_000 });
  const count = (seconds: number, used: number) => line(seconds, 'event_msg', { type: 'token_count', info: null, rate_limits: { primary: window(used, 300), secondary: window(20, 10080) } });
  const session = await parseCodex(writeLog([
    line(0, 'session_meta', { id: 'codex-limit' }),
    line(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Go' }] }),
    count(2, 40), count(3, 40), count(4, 92),
    line(5, 'event_msg', { type: 'error', message: 'You have hit your usage limit', codex_error_info: 'usage_limit_exceeded' }),
    line(6, 'event_msg', { type: 'stream_error', message: 'Reconnecting', codex_error_info: 'server_overloaded' }),
    line(7, 'event_msg', { type: 'stream_error', message: 'Stream disconnected, retrying' }),
    line(8, 'event_msg', { type: 'error', message: 'Something else broke' }),
  ]));
  assert.equal(session.quota!.length, 3, 'unchanged readings are dropped');
  assert.deepEqual(session.events.filter(e => e.limit).map(e => e.limit!.type), ['usage', 'capacity']);
  assert.ok(session.events.some(e => e.kind === 'system' && e.title === 'Something else broke'));
  assert.ok(!session.events.some(e => e.title.includes('retrying')));
  const analysis = analyze(session);
  assert.deepEqual(analysis.quota.map(q => [q.label, q.usedPercent]), [['5-hour', 92], ['weekly', 20]]);
  assert.ok(analysis.findings.some(f => f.rule === 'quota-pressure' && f.title.includes('92%')));
});

const geminiRecords = (seconds = at) => [
  { sessionId: 'gem-session-1', projectHash: 'abc', startTime: seconds(0), lastUpdated: seconds(0), kind: 'main', directories: ['/work/app'] },
  { id: 'u1', timestamp: seconds(0), type: 'user', content: [{ text: 'Fix the bug' }] },
  {
    id: 'g1', timestamp: seconds(2), type: 'gemini', content: [{ text: 'Looking' }], model: 'gemini-2.5-pro',
    thoughts: [{ subject: 'Plan', description: 'Read the file first', timestamp: seconds(1) }],
    tokens: { input: 1000, output: 100, cached: 400, thoughts: 50, tool: 10, total: 1160 },
    toolCalls: [{
      id: 'c1', name: 'read_file', args: { absolute_path: '/work/app/a.ts' }, status: 'success', timestamp: seconds(3),
      result: [{ functionResponse: { id: 'c1', name: 'read_file', response: { output: 'file body' } } }],
    }],
  },
  {
    id: 'g2', timestamp: seconds(9), type: 'gemini', content: '', model: 'gemini-2.5-pro',
    tokens: { input: 1200, output: 20, cached: 0, total: 1220 },
    toolCalls: [
      {
        id: 'c2', name: 'replace', args: { file_path: '/work/app/a.ts', old_string: 'x', new_string: 'y\nz' }, status: 'success', timestamp: seconds(10),
        resultDisplay: { fileName: 'a.ts', fileDiff: '--- a\n+++ b\n-x\n+y\n+z', diffStat: { model_added_lines: 2, model_removed_lines: 1 } },
      },
      { id: 'c3', name: 'run_shell_command', args: { command: 'npm test' }, status: 'error', timestamp: seconds(11), result: [{ functionResponse: { response: { error: 'tests failed' } } }] },
    ],
  },
  { id: 'e1', timestamp: seconds(20), type: 'error', content: 'You have exhausted your daily quota. Your quota will reset after 2h0m0s.' },
  { id: 'e2', timestamp: seconds(21), type: 'info', content: 'Switched theme' },
  { id: 'e3', timestamp: seconds(22), type: 'error', content: 'Something unrelated failed' },
];

test('gemini: parses append-only logs, tools, tokens and quota errors', async () => {
  const session = await parseGemini([writeLog(geminiRecords())]);
  assert.equal(session.agent, 'gemini-cli');
  assert.equal(session.key, 'gem-session-1');
  assert.equal(session.project, '/work/app');
  assert.equal(session.title, 'Fix the bug');
  const read = session.events.find(e => e.tool?.name === 'read_file')!;
  assert.equal(read.lane, 'read');
  assert.equal(read.tool!.output, 'file body');
  assert.deepEqual(read.tool!.file, { path: '/work/app/a.ts', op: 'read', added: 0, removed: 0 });
  assert.equal(read.durationMs, 6000, 'ends when the next message starts');
  const edit = session.events.find(e => e.tool?.name === 'replace')!;
  assert.deepEqual([edit.tool!.file!.added, edit.tool!.file!.removed], [2, 1]);
  assert.match(edit.tool!.diff!, /\+y/);
  const shell = session.events.find(e => e.tool?.name === 'run_shell_command')!;
  assert.equal(shell.tool!.isError, true);
  assert.equal(shell.tool!.output, 'tests failed');
  const usage = session.events.filter(e => e.usage);
  assert.equal(usage.length, 2);
  assert.deepEqual(usage[0]!.usage, { input: 610, output: 150, cacheRead: 400, cacheWrite5m: 0, cacheWrite1h: 0 });
  const limit = session.events.find(e => e.limit)!;
  assert.equal(limit.limit!.type, 'usage');
  assert.equal(limit.limit!.resetsAt, limit.ts + 7_200_000);
  assert.ok(session.events.some(e => e.kind === 'system' && e.title === 'Something unrelated failed'));
  assert.ok(!session.events.some(e => e.title === 'Switched theme'));
  const analysis = analyze(session);
  assert.equal(analysis.totals.limitHits, 1);
  assert.ok(analysis.totals.costUsd > 0);
  assert.ok(analysis.findings.some(f => f.rule === 'limit-hit' && f.detail.includes('ended at the limit') === false));
});

test('gemini: honours rewinds, patches, replacements and the legacy format', async () => {
  const [meta, user, first] = geminiRecords();
  const rewound = await parseGemini([writeLog([
    meta, user, first,
    { id: 'old', timestamp: at(5), type: 'gemini', content: 'Discarded reply', model: 'gemini-2.5-pro' },
    { $rewindTo: 'old' },
    { id: 'keep', timestamp: at(6), type: 'gemini', content: 'First draft', model: 'gemini-2.5-pro' },
    { id: 'keep', timestamp: at(6), type: 'gemini', content: 'Second draft', model: 'gemini-2.5-pro' },
    { $patch: { updates: [{ id: 'g1', toolCalls: [{ id: 'c1', result: 'patched output' }] }] } },
    { $set: { summary: 'A summary title' } },
    'broken line {',
  ])]);
  const texts = rewound.events.map(e => e.title);
  assert.ok(!texts.includes('Discarded reply'));
  assert.ok(!texts.includes('First draft'));
  assert.ok(texts.includes('Second draft'));
  assert.equal(rewound.events.find(e => e.tool)!.tool!.output, 'patched output');
  assert.equal(rewound.title, 'A summary title');

  const legacyPath = join(dir, 'session-legacy.json');
  const records = geminiRecords();
  writeFileSync(legacyPath, JSON.stringify({ ...(records[0] as object), messages: records.slice(1) }, null, 2));
  const legacy = await parseGemini([legacyPath]);
  assert.equal(legacy.key, 'gem-session-1');
  assert.ok(legacy.events.some(e => e.tool?.name === 'replace'));
});

test('gemini: discovered in its home folder with subagents, and sniffed from --dir', async () => {
  const home = mkdtempSync(join(dir, 'gemini-home-'));
  const chats = join(home, '.gemini', 'tmp', 'my-project', 'chats');
  mkdirSync(join(chats, 'abcd1234-rest-of-id'), { recursive: true });
  const main = join(chats, 'session-2026-01-01T12-00-abcd1234.jsonl');
  writeFileSync(main, geminiRecords().map(r => JSON.stringify(r)).join('\n'));
  writeFileSync(join(chats, 'session-2026-01-01T12-00-abcd1234.json'), '{"sessionId":"stale","messages":[]}');
  writeFileSync(join(chats, 'abcd1234-rest-of-id', 'sub-1.jsonl'), [
    { sessionId: 'sub-session', projectHash: 'abc', kind: 'subagent' },
    { id: 's1', timestamp: at(30), type: 'user', content: 'Subtask' },
  ].map(r => JSON.stringify(r)).join('\n'));
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'nothing');
  process.env.CODEX_HOME = join(dir, 'nothing');
  process.env.GEMINI_CLI_HOME = home;
  const sources = await discover();
  delete process.env.GEMINI_CLI_HOME;
  assert.equal(sources.length, 1, 'the stale .json next to its .jsonl is skipped');
  assert.equal(sources[0]!.paths.length, 2);
  const session = await parseGemini(sources[0]!.paths);
  assert.ok(session.events.some(e => e.sidechain === 'sub-sess'));

  const sniffed = await discover([main]);
  assert.equal(sniffed[0]!.agent, 'gemini-cli');
});

test('pricing: gemini rates and large prompt tiers', () => {
  const u = (input: number) => ({ input, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.equal(costOf('gemini-2.5-pro', u(100_000)), 0.125 + 10);
  assert.equal(costOf('gemini-2.5-pro', u(300_000)), 0.75 + 15);
  assert.equal(findPrice('gemini-2.5-flash-lite')?.input, 0.1, 'longest prefix wins over gemini-2.5-flash');
  assert.equal(findPrice('gemini-2.5-flash')?.input, 0.3);
  assert.equal(costOf('claude-haiku-5-5', u(200_000)), 0.1 + 2.5);
});

test('pricing: matches dated ids, platform prefixes and tiers', () => {
  assert.equal(findPrice('claude-sonnet-4-5-20250929')?.input, 3);
  assert.equal(findPrice('anthropic.claude-opus-5-5')?.input, 4);
  assert.equal(findPrice('claude-opus-5-5')?.input, 4, 'longest prefix wins over claude-opus-5');
  assert.equal(findPrice('gpt-5'), undefined);
  const u = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 };
  assert.equal(costOf('claude-opus-5-5', u), 4 + 20 + 0.2 + 5 + 8);
  assert.equal(costOf('claude-opus-5-5', { ...u, fast: true }), (4 + 20 + 0.2 + 5 + 8) * 2);
  assert.equal(costOf('unknown-model', u), undefined);
});

test('redaction: masks known secret shapes and keeps ordinary text', () => {
  const secrets = [
    'AKIAIOSFODNN7EXAMPLE',
    `sk-ant-${'a'.repeat(30)}`,
    `gh${'p'}_${'b'.repeat(36)}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    'password=hunter2hunter2',
    'postgres://shop:hunter2hunter2@db.internal/shop',
    'Authorization: Bearer abcdefghijklmnopqrstuvwx',
  ];
  for (const s of secrets) {
    assert.ok(containsSecret(s), s);
    assert.match(redactSecrets(s), /\[REDACTED:/, s);
  }
  assert.ok(!redactSecrets('postgres://shop:hunter2hunter2@db.internal/shop').includes('hunter2'));
  for (const s of ['const total = sum * rate;', 'password: $DB_PASSWORD', 'npm test -- src/checkout', 'see https://example.com/a?b=c']) {
    assert.equal(redactSecrets(s), s);
  }
});

test('demo session: every detector fires', async () => {
  const session = await parseClaude([demoPath]);
  const analysis = analyze(session);
  const rules = new Set(analysis.findings.map(f => f.rule));
  for (const rule of ['limit-hit', 'secret-exposure', 'risky-action', 'retry-loop', 'cache-rebuild', 'unverified-edits', 'redundant-read', 'edit-churn']) {
    assert.ok(rules.has(rule), `missing ${rule}; got ${[...rules].join(', ')}`);
  }
  assert.ok(analysis.totals.costUsd > 0);
  assert.ok(analysis.totals.wastedUsd <= analysis.totals.costUsd);
  assert.ok(session.events.some(e => e.sidechain === 'a7f3'), 'keeps subagent events');
  assert.ok(session.events.some(e => e.kind === 'compact'));
  for (const f of analysis.findings) {
    for (const id of f.eventIds) assert.ok(session.events[id], `${f.rule} points at a real event`);
  }
});

test('overview data: daily and model costs add up, stops carry their scope', async () => {
  const indexed = await buildIndex(await scanTree(demoDir), { useCache: false });
  assert.deepEqual([...new Set(indexed.map(i => i.summary.agent))].sort(), ['claude-code', 'codex', 'gemini-cli']);
  assert.equal(indexed[0]!.summary.key, 'demo-session', 'the richest story stays the latest for exports');
  for (const { summary: s } of indexed) {
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    assert.ok(near(Object.values(s.daily).reduce((n, v) => n + v, 0), s.costUsd), `${s.key} daily`);
    assert.ok(near(Object.values(s.modelCosts).reduce((n, v) => n + v, 0), s.costUsd), `${s.key} models`);
    for (const day of Object.keys(s.daily)) assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(s.limitStops.length, s.limitHits);
  }
  const refactor = indexed.find(i => i.summary.key === 'demo-refactor')!.summary;
  assert.equal(refactor.limitStops[0]!.scope, 'five hour');
  assert.ok(refactor.topFinding);
  assert.ok(indexed.find(i => i.summary.agent === 'gemini-cli')!.summary.costUsd > 0);
  assert.equal(indexed.find(i => i.summary.agent === 'codex')!.summary.hasUnpricedUsage, true);
});

test('findings tell the reader what to do', async () => {
  const analysis = analyze(await parseClaude([demoPath]));
  for (const f of analysis.findings) {
    if (f.severity === 'info') continue;
    assert.ok(f.advice, `${f.rule} has advice`);
  }
});

test('detectors stay quiet on a clean session', async () => {
  const session = await parseClaude([writeLog([
    { type: 'user', uuid: 'a', timestamp: at(0), message: { content: 'Add a helper' } },
    { type: 'assistant', uuid: 'b', timestamp: at(1), message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } }], usage } },
    { type: 'user', uuid: 'c', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', uuid: 'd', timestamp: at(3), message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }], usage } },
    { type: 'user', uuid: 'e', timestamp: at(4), message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'pass' }] } },
  ])]);
  assert.deepEqual(analyze(session).findings, []);
});

test('redactSession and export: no secret or script breakout in the file', async () => {
  const session = redactSession(await parseClaude([demoPath]));
  session.events[0]!.text = '</script><script>alert(1)</script>';
  const analysis = analyze(session);
  const html = renderExport(session, analysis);
  assert.ok(!html.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!html.includes('hunter2hunter2'));
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(!html.includes('href="style.css"'));
  assert.ok(!/<script src=/.test(html));
  assert.match(html, /script-src 'unsafe-inline'/);
  assert.ok(analysis.findings.some(f => f.rule === 'secret-exposure'), 'still reported after masking');
});

test('discover: attaches subagent logs and sniffs the format', async () => {
  const root = mkdtempSync(join(dir, 'tree-'));
  const main = join(root, 'abc.jsonl');
  writeFileSync(main, `${JSON.stringify({ type: 'user', uuid: 'a', sessionId: 'abc', timestamp: at(0), message: { content: 'hi' } })}\n`);
  mkdirSync(join(root, 'abc', 'subagents'), { recursive: true });
  writeFileSync(join(root, 'abc', 'subagents', 'agent-1.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'b', isSidechain: true, agentId: 's1', sessionId: 'abc', timestamp: at(1), message: { content: 'sub task' } })}\n`);
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'nothing');
  process.env.CODEX_HOME = join(dir, 'nothing');
  const sources = await discover([root]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.agent, 'claude-code');
  assert.equal(sources[0]!.paths.length, 2);
  const [item] = await buildIndex(sources, { useCache: false });
  assert.equal(item!.summary.key, 'abc');
});

test('server: rejects foreign hosts, masks by default, unknown ids 404', async () => {
  const sessions = await buildIndex([{ agent: 'claude-code', paths: [demoPath] }], { useCache: false });
  const server = createAppServer(sessions, { port: 0 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const get = (path: string, host = `127.0.0.1:${port}`) => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    request({ port, path, host: '127.0.0.1', headers: { Host: host } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    }).on('error', reject).end();
  });
  try {
    assert.equal((await get('/api/sessions', 'evil.example.com')).status, 403);
    assert.equal((await get('/api/sessions/nope')).status, 404);
    assert.equal((await get('/api/sessions/..%2F..%2Fsecret')).status, 404);
    const index = await get('/');
    assert.equal(index.status, 200);
    assert.match(String(index.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(index.headers['access-control-allow-origin'], undefined);
    sessions[0]!.summary.title = 'Use password=hunter2hunter2 here';
    const list = await get('/api/sessions');
    assert.ok(!list.body.includes('hunter2hunter2'), 'the session list is masked too');
    assert.ok((await get('/api/sessions?redact=0')).body.includes('hunter2hunter2'));
    const masked = await get(`/api/sessions/${sessions[0]!.summary.key}`);
    assert.ok(!masked.body.includes('AKIAIOSFODNN7EXAMPLE'));
    const raw = await get(`/api/sessions/${sessions[0]!.summary.key}?redact=0`);
    assert.ok(raw.body.includes('AKIAIOSFODNN7EXAMPLE'));
  } finally {
    server.close();
  }
});
