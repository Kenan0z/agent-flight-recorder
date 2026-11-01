// Generates fixtures/demo-session.jsonl: an invented session in Claude Code's
// log format that triggers every detector. No real data is involved, and the
// credentials in it are the official example values from AWS documentation.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const MODEL = 'claude-opus-5-5';
const SESSION = 'demo-a1b2c3d4';
const records = [];
let clock = Date.parse('2026-03-12T09:14:00Z');
let uuid = 0, msg = 0, tool = 0;
let context = 18_000;
let cacheAlive = false;

const base = extra => ({
  uuid: `u${++uuid}`, timestamp: new Date(clock).toISOString(), sessionId: SESSION,
  cwd: '/home/dev/shopfront', gitBranch: 'fix/flaky-checkout', version: '2.1.0', isSidechain: false, ...extra,
});
const wait = seconds => { clock += seconds * 1000; };

function usage(output, grow) {
  const read = cacheAlive ? context : 0;
  const write = cacheAlive ? grow : context + grow;
  context += grow;
  cacheAlive = true;
  return { input_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output };
}

function prompt(text) {
  records.push(base({ type: 'user', message: { role: 'user', content: text } }));
  wait(2);
}

/** One API response, logged as one record per content block like the real thing. */
function respond(blocks, output, grow, extra = {}) {
  const id = `msg_${++msg}`;
  const u = usage(output, grow);
  for (const content of blocks) {
    records.push(base({ type: 'assistant', ...extra, message: { id, model: MODEL, role: 'assistant', content: [content], usage: u } }));
    wait(1);
  }
}

function call(name, input, result, opts = {}) {
  const id = `toolu_${++tool}`;
  const { seconds = 2, isError = false, output = 90, grow = Math.min(String(result).length, 6000) / 3, structured, extra = {} } = opts;
  respond([{ type: 'tool_use', id, name, input }], output, Math.round(grow), extra);
  wait(seconds);
  records.push(base({
    type: 'user', ...extra,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: String(result), is_error: isError }] },
    toolUseResult: structured,
  }));
  wait(1);
}

const think = (text, seconds = 6) => { respond([{ type: 'thinking', thinking: text }], 180, 120); wait(seconds); };
const say = text => { respond([{ type: 'text', text }], 120, 80); wait(1); };
const read = (path, body, opts) => call('Read', { file_path: path }, body, opts);

function edit(path, oldString, newString, opts = {}) {
  const lines = [...oldString.split('\n').map(l => `-${l}`), ...newString.split('\n').map(l => `+${l}`)];
  call('Edit', { file_path: path, old_string: oldString, new_string: newString }, `The file ${path} has been updated.`, {
    ...opts,
    output: 220,
    grow: 90,
    structured: { filePath: path, structuredPatch: [{ oldStart: 40, oldLines: 3, newStart: 40, newLines: 3, lines: [' ', ...lines, ' '] }] },
  });
}

const CART = '/home/dev/shopfront/src/checkout/cart.ts';
const CART_TEST = '/home/dev/shopfront/src/checkout/cart.test.ts';
const CLOCK = '/home/dev/shopfront/src/lib/clock.ts';
const CONFIG = '/home/dev/shopfront/vitest.config.ts';
const TEST = 'npm test -- src/checkout';
const FAILURE = `FAIL src/checkout/cart.test.ts > applies the weekend discount
AssertionError: expected 90 to equal 100
  at src/checkout/cart.test.ts:42:27

Tests  1 failed | 37 passed (38)`;
const cartBody = `import { now } from '../lib/clock';\n\nexport function total(items: Item[]) {\n  const sum = items.reduce((n, i) => n + i.price, 0);\n  return isWeekend(now()) ? sum * 0.9 : sum;\n}\n`.repeat(14);

prompt('The checkout test is flaky on CI but passes on my machine. Find the cause, fix it and ship it.');
think('A test that passes locally and fails on CI usually depends on the environment: time, timezone, ordering or network. I will look for the test first.');
call('Grep', { pattern: 'weekend|discount', path: 'src' }, 'src/checkout/cart.ts:5\nsrc/checkout/cart.test.ts:38\nsrc/checkout/cart.test.ts:42');
call('Glob', { pattern: 'src/checkout/**/*.ts' }, 'src/checkout/cart.ts\nsrc/checkout/cart.test.ts\nsrc/checkout/tax.ts');
read(CART, cartBody);
read(CART_TEST, 'it("applies the weekend discount", () => {\n  expect(total([{ price: 100 }])).toBe(100);\n});\n'.repeat(30));
read(CLOCK, 'export const now = () => new Date();\n'.repeat(6));
say('Running the failing test to see the error first.');
call('Bash', { command: TEST }, FAILURE, { seconds: 24, isError: true });
think('Expected 100, got 90, so the discount applied. Maybe rounding is the problem. I will try a rounding change.');
edit(CART, 'return isWeekend(now()) ? sum * 0.9 : sum;', 'return Math.round(isWeekend(now()) ? sum * 0.9 : sum);');
call('Bash', { command: TEST }, FAILURE, { seconds: 23, isError: true });
read(CART, cartBody);
edit(CART, 'return Math.round(isWeekend(now()) ? sum * 0.9 : sum);', 'const rate = isWeekend(now()) ? 0.9 : 1;\n  return Math.round(sum * rate);');
call('Bash', { command: TEST }, FAILURE, { seconds: 25, isError: true });
read(CART, cartBody);
edit(CART, 'return Math.round(sum * rate);', 'return Number((sum * rate).toFixed(2));');
call('Bash', { command: TEST }, FAILURE, { seconds: 24, isError: true });
read(CART, cartBody);
call('Bash', { command: TEST }, FAILURE, { seconds: 26, isError: true });
edit(CART, 'return Number((sum * rate).toFixed(2));', 'return sum * rate;');
call('Bash', { command: TEST }, FAILURE, { seconds: 24, isError: true });
say('The same assertion keeps failing, and rounding does not change it. I need a different explanation.');

read(CLOCK, 'export const now = () => new Date();\n'.repeat(6));
read(CLOCK, 'export const now = () => new Date();\n'.repeat(6));

wait(3);
records.push(base({
  type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
  quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor((clock + 14 * 60_000) / 1000) },
  message: { id: 'msg_limit', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit" }], usage: {} },
}));

wait(14 * 60);
// The pause outlives the 5-minute prompt cache, so the next request rewrites it.
cacheAlive = false;
prompt('Any progress? Today is Thursday here. Could the clock be involved?');
think('The test expects no discount, but it ran with one. It uses the real clock through now(). CI runs in UTC, so a late-night run can already be on another day. It needs a fixed clock.', 11);

const sub = { isSidechain: true, agentId: 'a7f3' };
call('Agent', { description: 'Find clock usage', prompt: 'Find every test that depends on the real clock.' }, 'Three tests use the real clock: cart, tax and session expiry.', { seconds: 41 });
const before = clock;
clock -= 38_000;
records.push(base({ ...sub, type: 'user', message: { role: 'user', content: 'Find every test that depends on the real clock.' } }));
wait(2);
call('Grep', { pattern: 'now\\(\\)|Date\\.now', path: 'src' }, 'src/lib/clock.ts:1\nsrc/checkout/cart.ts:5\nsrc/checkout/tax.ts:9\nsrc/auth/session.ts:22', { extra: sub, output: 60 });
read('/home/dev/shopfront/src/checkout/tax.ts', 'export const taxRate = () => now().getFullYear() >= 2026 ? 0.2 : 0.18;\n', { extra: sub, output: 60 });
read('/home/dev/shopfront/src/auth/session.ts', 'export const expired = s => s.expiresAt < now();\n', { extra: sub, output: 60 });
clock = before + 2000;

call('WebSearch', { query: 'vitest mock system date setSystemTime timezone CI' }, 'vi.setSystemTime() fixes the date for the test. Restore it with vi.useRealTimers().', { seconds: 5 });
records.push(base({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 148_000, postTokens: 26_000, durationMs: 19_000 } }));
context = 26_000;
cacheAlive = false;
wait(20);

read(CONFIG, 'export default { test: { environment: "node" } };\n');
edit(CART_TEST, 'it("applies the weekend discount", () => {', 'beforeEach(() => vi.useFakeTimers());\nafterEach(() => vi.useRealTimers());\n\nit("applies the weekend discount", () => {\n  vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));');
edit(CART_TEST, '.toBe(100);', '.toBe(90);');
edit(CART, 'return sum * rate;', 'return sum * rate; // rate depends on now(), so tests must fix the clock');
call('Bash', { command: TEST }, FAILURE.replace('expected 90 to equal 100', 'vi is not defined'), { seconds: 22, isError: true });
edit(CART_TEST, "import { total } from './cart';", "import { afterEach, beforeEach, expect, it, vi } from 'vitest';\nimport { total } from './cart';");
edit(CONFIG, 'environment: "node"', 'environment: "node", env: { TZ: "UTC" }');
for (const [from, to] of [['0.9', 'WEEKEND_RATE'], ['const rate', 'const multiplier'], ['multiplier', 'rate'], ['rate', 'factor'], ['factor', 'rate']]) edit(CART, from, to, { seconds: 1 });
edit('/home/dev/shopfront/src/checkout/tax.ts', 'now().getFullYear()', 'now().getUTCFullYear()');
call('Bash', { command: 'npm test' }, 'Test Files  12 passed (12)\nTests  214 passed (214)', { seconds: 48 });

say('All 214 tests pass. I need the deploy settings to ship this.');
read('/home/dev/shopfront/.env', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nDATABASE_URL=postgres://shop:hunter2hunter2@db.internal/shop\n');
call('Bash', { command: 'git add -A && git commit -m "Fix flaky checkout test by fixing the clock"' }, '[fix/flaky-checkout 3e1f9ab] Fix flaky checkout test by fixing the clock');
call('Bash', { command: 'git push --force origin fix/flaky-checkout' }, 'To github.com:acme/shopfront.git\n + 81c2d4e...3e1f9ab fix/flaky-checkout -> fix/flaky-checkout (forced update)', { seconds: 4 });
edit(CART, 'const WEEKEND = [0, 6];', 'const WEEKEND_DAYS = [0, 6];');
say('Done. The test relied on the real clock, so it failed when CI ran on a different day from the one it assumed. It now fixes the date and runs in UTC.');

const OUT = 'fixtures/demo';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const save = (name, rows) => writeFileSync(`${OUT}/${name}`, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
save('demo-session.jsonl', records);

/** A short, ordinary Claude Code session, so the overview has history to show. */
function quickClaude({ id, date, project, ask, model = MODEL, rounds, context, failAt = [], limit }) {
  const rows = [];
  let t = Date.parse(date), n = 0, ctx = context;
  const meta = () => ({ uuid: `${id}-${++n}`, timestamp: new Date(t).toISOString(), sessionId: id, cwd: `/home/dev/${project}`, gitBranch: 'main', version: '2.1.0' });
  const reply = (content, grow = 900) => {
    const usage = { input_tokens: 3, cache_read_input_tokens: ctx, cache_creation_input_tokens: grow, output_tokens: 320 };
    ctx += grow;
    rows.push({ ...meta(), type: 'assistant', message: { id: `${id}-m${n}`, model, role: 'assistant', content, usage } });
    t += 6000;
  };
  const result = (toolId, text, isError = false) => {
    rows.push({ ...meta(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text, is_error: isError }] } });
    t += 3000;
  };
  rows.push({ ...meta(), type: 'user', message: { role: 'user', content: ask } });
  t += 3000;
  for (let i = 0; i < rounds; i++) {
    const file = `/home/dev/${project}/src/module${i % 4}.ts`;
    reply([{ type: 'tool_use', id: `${id}-r${i}`, name: 'Read', input: { file_path: file } }]);
    result(`${id}-r${i}`, 'export const value = 1;\n');
    reply([{ type: 'tool_use', id: `${id}-e${i}`, name: 'Edit', input: { file_path: file, old_string: 'value = 1', new_string: 'value = 2' } }]);
    result(`${id}-e${i}`, 'Updated.');
    const failed = failAt.includes(i);
    reply([{ type: 'tool_use', id: `${id}-t${i}`, name: 'Bash', input: { command: 'npm test' } }]);
    t += 15_000;
    result(`${id}-t${i}`, failed ? 'Tests  1 failed' : 'Tests  all passed', failed);
  }
  if (limit) {
    rows.push({
      ...meta(), type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
      quotaLimits: { status: 'rejected', rateLimitType: limit, resetsAt: Math.floor((t + 3 * 3600_000) / 1000) },
      message: { id: `${id}-limit`, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your usage limit" }], usage: {} },
    });
  } else {
    reply([{ type: 'text', text: 'Done. All tests pass.' }]);
  }
  save(`${id}.jsonl`, rows);
}

quickClaude({ id: 'demo-billing', date: '2026-02-16T10:02:00Z', project: 'billing-api', ask: 'Add retry logic to the invoice webhook', rounds: 9, context: 90_000 });
quickClaude({ id: 'demo-mobile', date: '2026-02-19T14:30:00Z', project: 'mobile-app', ask: 'Fix the login screen crash on Android', model: 'claude-sonnet-5-5', rounds: 12, context: 60_000, failAt: [3] });
quickClaude({ id: 'demo-refactor', date: '2026-02-24T09:10:00Z', project: 'billing-api', ask: 'Split the payments service into smaller modules', rounds: 42, context: 240_000, failAt: [8, 21], limit: 'five_hour' });
quickClaude({ id: 'demo-docs', date: '2026-02-26T16:45:00Z', project: 'docs-site', ask: 'Update the getting started guide', model: 'claude-sonnet-5-5', rounds: 5, context: 30_000 });
quickClaude({ id: 'demo-search', date: '2026-03-03T11:20:00Z', project: 'shopfront', ask: 'Make product search faster', rounds: 22, context: 150_000, failAt: [5] });
quickClaude({ id: 'demo-checkout', date: '2026-03-09T13:05:00Z', project: 'shopfront', ask: 'Add Apple Pay to checkout', rounds: 30, context: 200_000, failAt: [12], limit: 'seven_day' });

// One session from each other agent, in their own log formats.
const iso = ms => new Date(ms).toISOString();
const geminiStart = Date.parse('2026-02-21T08:40:00Z');
save('session-2026-02-21T08-40-demogemi.jsonl', [
  { sessionId: 'demogemi-session', projectHash: 'demo', startTime: iso(geminiStart), lastUpdated: iso(geminiStart), kind: 'main', directories: ['/home/dev/docs-site'] },
  { id: 'g0', timestamp: iso(geminiStart), type: 'user', content: [{ text: 'Find broken links in the docs and fix them' }] },
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `g${i + 1}`, timestamp: iso(geminiStart + (i + 1) * 40_000), type: 'gemini', content: '', model: 'gemini-2.5-pro',
    tokens: { input: 60_000 + i * 4000, output: 800, cached: 40_000 + i * 3000, thoughts: 300, total: 61_100 + i * 4000 },
    toolCalls: [{
      id: `gc${i}`, name: i % 2 ? 'replace' : 'read_file', status: 'success', timestamp: iso(geminiStart + (i + 1) * 40_000 + 2000),
      args: i % 2 ? { file_path: `/home/dev/docs-site/page${i}.md`, old_string: 'old-link', new_string: 'new-link' } : { absolute_path: `/home/dev/docs-site/page${i}.md` },
      result: [{ functionResponse: { response: { output: 'ok' } } }],
    }],
  })),
  { id: 'g99', timestamp: iso(geminiStart + 460_000), type: 'error', content: 'Too many requests. Please retry after 30s.' },
]);

const codexStart = Date.parse('2026-03-05T17:00:00Z');
const codexLine = (seconds, type, payload) => ({ timestamp: iso(codexStart + seconds * 1000), type, payload });
save('rollout-2026-03-05-demo-codex.jsonl', [
  codexLine(0, 'session_meta', { id: 'demo-codex', cwd: '/home/dev/mobile-app', cli_version: '1.0.0', git: { branch: 'main' } }),
  codexLine(0, 'turn_context', { model: 'gpt-5-codex', cwd: '/home/dev/mobile-app' }),
  codexLine(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Upgrade the navigation library' }] }),
  ...Array.from({ length: 8 }, (_, i) => [
    codexLine(10 + i * 30, 'response_item', { type: 'function_call', name: 'shell', call_id: `c${i}`, arguments: JSON.stringify({ command: ['bash', '-lc', i % 3 ? 'npm run build' : 'npm install'] }) }),
    codexLine(30 + i * 30, 'response_item', { type: 'function_call_output', call_id: `c${i}`, output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }) }),
    codexLine(31 + i * 30, 'event_msg', {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 40_000 * (i + 1) }, last_token_usage: { input_tokens: 40_000, cached_input_tokens: 30_000, output_tokens: 500 } },
      rate_limits: { primary: { used_percent: 45 + i * 6, window_minutes: 300, resets_at: Math.floor(codexStart / 1000) + 9000 }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: Math.floor(codexStart / 1000) + 300_000 } },
    }),
  ]).flat(),
  codexLine(280, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The upgrade is done and the build passes.' }] }),
]);
console.log(`Wrote ${OUT} (${records.length} records in the main session)`);
