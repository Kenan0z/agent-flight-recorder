// Transcript text is untrusted: an agent can read any file or page. Everything
// here renders through textContent, and innerHTML is never used.
'use strict';

const $ = id => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child);
  }
  return el;
}

/** Technical view: one row per kind of step. */
const LANES = {
  prompt: 'You', think: 'Thinking', say: 'Replies', read: 'Reads', write: 'Edits', shell: 'Commands',
  search: 'Search', web: 'Web', agent: 'Subagents', mcp: 'MCP', other: 'Other', limit: 'Limits', system: 'System',
};
/** Simple view: the same steps, grouped the way a reader thinks about them. */
const SIMPLE_ROWS = [
  { label: 'You', color: 'prompt', lanes: ['prompt'] },
  { label: 'Agent thinking', color: 'think', lanes: ['think', 'say'] },
  { label: 'Reading files', color: 'read', lanes: ['read', 'search', 'web'] },
  { label: 'Changing files', color: 'write', lanes: ['write'] },
  { label: 'Running commands', color: 'shell', lanes: ['shell'] },
  { label: 'Other tools', color: 'web', lanes: ['agent', 'mcp', 'other'] },
  { label: 'Limits', color: 'limit', lanes: ['limit'] },
];
const AGENTS = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI' };
const LIMIT_TYPES = { usage: 'Usage limit', rate: 'Too many requests', capacity: 'Provider overloaded' };
const GROUPS = [
  { severities: ['high'], label: 'Needs your attention' },
  { severities: ['medium'], label: 'Worth a look' },
  { severities: ['low', 'info'], label: 'Good to know' },
];
const RANGES = [{ days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 0, label: 'All' }];

const GAP_MS = 60_000;
const GAP_SHOWN_MS = 12_000;
const LANE_H = 21;
const TOP_H = 20;
const CTX_H = 62;
const LABEL_W = 128;
const LOG_ROW = 28;
const REPLAY_MS = 60_000;

const money = n => (n === undefined || n === null ? '–' : n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const count = n => Number(n).toLocaleString('en-US');
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
function compact(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}
function dur(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
// The interface is in English, so dates match it instead of following the browser.
const LOCALE = 'en-GB';
const clockTime = ts => new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fullDate = ts => new Date(ts).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const shortDate = ts => new Date(ts).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
const baseName = p => p.split(/[\\/]/).filter(Boolean).pop() || p;
const promptOf = u => (u ? u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h : 0);
const projectName = s => (s.project ? baseName(s.project) : 'Unknown project');
const scopeName = scope => (!scope ? 'Usage limit' : /^five.?hour/i.test(scope) ? '5-hour limit' : /^seven.?day/i.test(scope) ? 'Weekly limit' : `${scope} limit`);

function storedDetail() {
  try {
    return localStorage.getItem('flightrec.detailed') === '1';
  } catch {
    return false;
  }
}

const state = {
  summaries: [], key: null, session: null, analysis: null, tl: null,
  selected: 0, playing: false, playT: 0, tab: 'findings', detailed: storedDetail(),
  view: { from: 0, to: 1 }, filtered: [], filterActive: false, filteredSet: new Set(), colors: {},
  rangeDays: 30, tableQuery: '',
};
const embedded = window.__FLIGHTREC__;

function showTip(text, x, y) {
  const tip = $('tooltip');
  tip.textContent = text;
  tip.hidden = false;
  tip.style.left = `${Math.max(Math.min(x + 12, innerWidth - tip.offsetWidth - 8), 8)}px`;
  tip.style.top = `${y + 16}px`;
}
const hideTip = () => { $('tooltip').hidden = true; };

function showOnly(id) {
  for (const name of ['empty', 'overview', 'workspace']) $(name).hidden = name !== id;
  $('main').scrollTop = 0;
}

function showEmpty(title, ...lines) {
  showOnly('empty');
  $('empty').replaceChildren(h('h2', {}, title), ...lines.map(l => h('p', {}, l)));
}

/* ---------- overview ---------- */

function dayFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function keyFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Days from the range start through the latest activity, so a quiet week never reads as empty. */
function rangeKeys() {
  const all = state.summaries.flatMap(s => Object.keys(s.daily)).sort();
  if (!all.length) return [];
  const end = dayFromKey(all.at(-1));
  const start = state.rangeDays ? new Date(end.getFullYear(), end.getMonth(), end.getDate() - state.rangeDays + 1) : dayFromKey(all[0]);
  const keys = [];
  for (let d = start; d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) keys.push(keyFromDate(d));
  return keys;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

function dayChart(keys, costs, stops) {
  const weekly = keys.length > 92;
  const buckets = [];
  for (let i = 0; i < keys.length; i += weekly ? 7 : 1) {
    const slice = keys.slice(i, i + (weekly ? 7 : 1));
    buckets.push({
      label: weekly ? `Week of ${shortDate(dayFromKey(slice[0]))}` : dayFromKey(slice[0]).toLocaleDateString(LOCALE, { weekday: 'short', month: 'short', day: 'numeric' }),
      cost: slice.reduce((n, k) => n + (costs[k] ?? 0), 0),
      stops: slice.reduce((n, k) => n + (stops[k] ?? 0), 0),
    });
  }
  const top = niceMax(Math.max(...buckets.map(b => b.cost), 0));
  const label = `Estimated spend per ${weekly ? 'week' : 'day'}. Highest ${money(Math.max(...buckets.map(b => b.cost)))}.`;
  const grid = [1, .5, 0].map(f => {
    const line = h('div', { class: 'day-gridline' }, h('span', {}, `$${(top * f).toFixed(top < 4 ? 2 : 0)}`));
    line.style.top = `${(1 - f) * 100}%`;
    return line;
  });
  const bars = buckets.map(b => {
    const bar = h('div', { class: 'day-bar' });
    bar.style.height = b.cost > 0 ? `${Math.max((b.cost / top) * 100, 1.5)}%` : '0';
    const text = `${b.label}: ${money(b.cost)}${b.stops ? `, stopped by a limit ${b.stops === 1 ? 'once' : `${b.stops} times`}` : ''}`;
    return h('div', {
      class: 'day', title: text,
      onpointermove: ev => showTip(text, ev.clientX, ev.clientY),
      onpointerleave: hideTip,
    }, b.stops ? h('span', { class: 'day-limit', 'aria-hidden': 'true' }, '▼') : null, bar);
  });
  const chart = h('div', { class: 'daychart', role: 'img', 'aria-label': label },
    h('div', { class: 'day-grid' }, grid),
    h('div', { class: 'day-bars' }, bars),
    h('div', { class: 'day-axis' }, h('span', {}, shortDate(dayFromKey(keys[0]))), h('span', {}, shortDate(dayFromKey(keys.at(-1))))),
  );
  return chart;
}

function barList(rows) {
  if (!rows.length) return [h('div', { class: 'none' }, 'No priced usage in this period.')];
  const top = Math.max(...rows.map(r => r.value), 0.0001);
  const shown = rows.slice(0, 6);
  const rest = rows.slice(6).reduce((n, r) => n + r.value, 0);
  if (rest > 0) shown.push({ name: `${rows.length - 6} more`, value: rest });
  return shown.map(r => {
    const fill = h('div', { class: 'hbar-fill' });
    fill.style.width = `${Math.min((r.value / top) * 100, 100)}%`;
    return h('div', { class: 'hbar-row' },
      h('span', { class: 'hbar-name', title: r.name }, r.name),
      h('span', { class: 'hbar-value' }, money(r.value)),
      h('div', { class: 'hbar-track' }, fill),
    );
  });
}

function statusOf(s) {
  if (s.highFindings) return h('span', { class: 'status bad' }, `● ${plural(s.highFindings, 'problem')}`);
  if (s.findings) return h('span', { class: 'status note' }, `○ ${plural(s.findings, 'note')}`);
  return h('span', { class: 'status ok' }, '✓ Looks fine');
}

function sessionRow(s) {
  return h('a', { class: 'session-row', href: `#${encodeURIComponent(s.key)}` },
    h('span', { class: 'session-main' },
      h('span', { class: 'session-title' }, s.title),
      h('span', { class: 'session-sub' }, `${projectName(s)} · ${AGENTS[s.agent] ?? s.agent}`),
    ),
    h('span', { class: 'session-when' }, shortDate(s.endedAt)),
    h('span', { class: 'session-cost' }, s.hasUnpricedUsage && !s.costUsd ? 'n/a' : money(s.costUsd)),
    statusOf(s),
  );
}

function renderSessionTable(box, rows) {
  const query = state.tableQuery.trim().toLowerCase();
  const matches = rows.filter(s => !query || `${s.title} ${s.project ?? ''} ${AGENTS[s.agent]}`.toLowerCase().includes(query));
  box.replaceChildren(...(matches.length ? matches.map(sessionRow) : [h('div', { class: 'none' }, 'No matching sessions.')]));
}

function renderOverview() {
  pause();
  state.session = null;
  state.key = null;
  document.title = 'Flight Recorder';
  showOnly('overview');
  const keys = rangeKeys();
  const inRange = new Set(keys);
  const costs = {}, stops = {}, projects = {}, models = {};
  let spend = 0, saved = 0, unpriced = false;
  const rows = [], stopList = [];
  for (const s of state.summaries) {
    const days = Object.keys(s.daily).filter(k => inRange.has(k));
    if (!days.length) continue;
    rows.push(s);
    let portion = 0;
    for (const k of days) {
      costs[k] = (costs[k] ?? 0) + s.daily[k];
      portion += s.daily[k];
    }
    spend += portion;
    if (s.costUsd > 0) saved += s.wastedUsd * (portion / s.costUsd);
    unpriced ||= s.hasUnpricedUsage;
    const name = projectName(s);
    projects[name] = (projects[name] ?? 0) + portion;
    // Model totals are per session, so scale them to the part inside this period.
    const share = s.costUsd > 0 ? portion / s.costUsd : 0;
    for (const [model, cost] of Object.entries(s.modelCosts)) models[model] = (models[model] ?? 0) + cost * share;
    for (const stop of s.limitStops) {
      const day = keyFromDate(new Date(stop.ts));
      if (!inRange.has(day)) continue;
      stops[day] = (stops[day] ?? 0) + 1;
      stopList.push({ ...stop, session: s });
    }
  }
  stopList.sort((a, b) => b.ts - a.ts);
  const attention = rows.filter(s => s.highFindings).slice(0, 5);
  const sorted = obj => Object.entries(obj).map(([name, value]) => ({ name, value })).filter(r => r.value > 0).sort((a, b) => b.value - a.value);

  const segmented = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Time period' },
    RANGES.map(r => h('button', {
      type: 'button', 'aria-pressed': String(state.rangeDays === r.days),
      onclick: () => { state.rangeDays = r.days; renderOverview(); },
    }, r.label)));

  const card = (value, label, note, bad) => h('div', { class: 'card' },
    h('div', { class: `card-value${bad ? ' bad' : ''}` }, value),
    h('div', { class: 'card-label' }, label),
    h('div', { class: 'card-note' }, note));

  const tableBox = h('div', {});
  const search = h('input', {
    type: 'search', placeholder: 'Search sessions', value: state.tableQuery, 'aria-label': 'Search sessions',
    oninput: ev => { state.tableQuery = ev.target.value; renderSessionTable(tableBox, rows); },
  });
  renderSessionTable(tableBox, rows);

  $('overview').replaceChildren(
    h('div', { class: 'ov-head' },
      h('div', {},
        h('h1', {}, 'Overview'),
        h('p', { class: 'ov-range' }, keys.length ? `${shortDate(dayFromKey(keys[0]))} to ${shortDate(dayFromKey(keys.at(-1)))}` : ''),
      ),
      segmented,
    ),
    h('div', { class: 'cards' },
      card(`${money(spend)}${unpriced ? '+' : ''}`, 'Estimated cost', unpriced ? 'Some AI models have no known price. Subscriptions bill differently.' : 'At API prices. Subscriptions bill differently.'),
      card(money(saved), 'Could be saved', 'Spent on repeated failures and reloads.', saved > 0),
      card(count(rows.length), rows.length === 1 ? 'Session' : 'Sessions', `${count(attention.length)} with problems`),
      card(count(stopList.length), 'Limit stops', stopList.length ? 'Times a usage limit halted the work.' : 'No usage limit stopped your work.', stopList.length > 0),
    ),
    h('section', { class: 'panel' },
      h('h2', {}, 'Spending over time'),
      h('p', { class: 'panel-note' }, stopList.length ? 'Estimated cost. ▼ marks a usage limit stop.' : 'Estimated cost.'),
      keys.length ? dayChart(keys, costs, stops) : null,
    ),
    h('div', { class: 'two-col' },
      h('section', { class: 'panel' },
        h('h2', {}, 'Needs your attention'),
        h('p', { class: 'panel-note' }, 'Sessions with something serious to check.'),
        attention.length
          ? attention.map(s => h('a', { class: 'attention-row', href: `#${encodeURIComponent(s.key)}` },
              h('span', { class: 'attention-title' }, s.title),
              h('span', { class: 'attention-why' }, s.topFinding),
            ))
          : h('div', { class: 'none' }, '✓ Nothing serious found in this period.'),
      ),
      h('section', { class: 'panel' },
        h('h2', {}, 'Usage limits'),
        h('p', { class: 'panel-note' }, 'When a limit stopped the agent, newest first.'),
        stopList.length
          ? stopList.slice(0, 5).map(stop => h('a', { class: 'attention-row', href: `#${encodeURIComponent(stop.session.key)}` },
              h('span', { class: 'attention-title' }, `${scopeName(stop.scope)} · ${fullDate(stop.ts)}`),
              h('span', { class: 'attention-why' }, `${stop.session.title}${stop.resetsAt ? ` · resets ${fullDate(stop.resetsAt)}` : ''}`),
            ))
          : h('div', { class: 'none' }, '✓ You did not hit a usage limit in this period.'),
      ),
      h('section', { class: 'panel' },
        h('h2', {}, 'Cost by project'),
        h('p', { class: 'panel-note' }, 'Estimated cost in this period.'),
        barList(sorted(projects)),
      ),
      h('section', { class: 'panel' },
        h('h2', {}, 'Cost by AI model'),
        h('p', { class: 'panel-note' }, unpriced ? 'Models without a known price are left out.' : 'Estimated cost in this period.'),
        barList(sorted(models)),
      ),
    ),
    h('section', { class: 'panel' },
      h('div', { class: 'table-tools' }, h('h2', {}, 'Sessions'), search),
      tableBox,
    ),
  );
}

/* ---------- timeline model ---------- */

function buildTimeline(session) {
  const events = session.events;
  const n = events.length;
  const x = new Float64Array(n), w = new Float64Array(n);
  const gaps = [];
  const start = events[0].ts;
  let collapsed = 0, frontier = start;
  for (let i = 0; i < n; i++) {
    const e = events[i];
    const gap = e.ts - frontier;
    if (gap > GAP_MS) {
      collapsed += gap - GAP_SHOWN_MS;
      gaps.push({ x: e.ts - start - collapsed - GAP_SHOWN_MS, ms: gap });
    }
    x[i] = e.ts - start - collapsed;
    // A tool call that outlives a long pause (waiting on approval, say) must
    // not stretch the axis, so its bar is capped at the same limit.
    w[i] = Math.min(e.durationMs, GAP_MS);
    frontier = Math.max(frontier, Math.min(e.ts + e.durationMs, e.ts + GAP_MS));
  }
  let total = 1;
  for (let i = 0; i < n; i++) total = Math.max(total, x[i] + w[i]);

  const present = new Set(events.map(e => e.lane));
  const rows = state.detailed
    ? Object.keys(LANES).filter(l => present.has(l)).map(l => ({ label: LANES[l], color: l, lanes: [l] }))
    : SIMPLE_ROWS.filter(r => r.lanes.some(l => present.has(l)));
  const rowOfLane = {};
  rows.forEach((r, i) => { for (const l of r.lanes) rowOfLane[l] = i; });
  const row = new Int16Array(n);
  for (let i = 0; i < n; i++) row[i] = rowOfLane[events[i].lane] ?? -1;

  const cumCost = new Float64Array(n), cumLinesAdd = new Int32Array(n), cumLinesDel = new Int32Array(n);
  const ctx = [];
  let cost = 0, add = 0, del = 0, peak = 1;
  for (let i = 0; i < n; i++) {
    const e = events[i];
    cost += e.costUsd ?? 0;
    const f = e.tool?.file;
    if (f && f.op !== 'read' && !e.tool.isError) { add += f.added; del += f.removed; }
    cumCost[i] = cost; cumLinesAdd[i] = add; cumLinesDel[i] = del;
    if (e.usage && !e.sidechain) {
      const size = promptOf(e.usage);
      ctx.push({ x: x[i], size, i });
      peak = Math.max(peak, size);
    }
  }
  return { x, w, gaps, total, rows, row, cumCost, cumLinesAdd, cumLinesDel, ctx, peak };
}

const contextAt = i => {
  const events = state.session.events;
  for (let k = i; k >= 0; k--) if (events[k].usage && !events[k].sidechain) return promptOf(events[k].usage);
  return 0;
};

/* ---------- chart ---------- */

const canvas = $('chart');
const ctx2d = canvas.getContext('2d');
let cssW = 0, cssH = 0, needsDraw = false;

function readColors() {
  const s = getComputedStyle(document.documentElement);
  const get = name => s.getPropertyValue(name).trim();
  state.colors = {
    bg: get('--panel'), alt: get('--panel-2'), line: get('--line'), text: get('--text'), muted: get('--muted'),
    accent: get('--accent'), bad: get('--bad'), mono: get('--mono'), sans: get('--sans'),
    lane: Object.fromEntries(Object.keys(LANES).map(l => [l, get(`--lane-${l}`)])),
  };
}

function resizeChart() {
  if (!state.tl || $('workspace').hidden) return;
  cssW = canvas.parentElement.clientWidth;
  cssH = TOP_H + state.tl.rows.length * LANE_H + (state.detailed ? CTX_H + 6 : 8);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * ratio);
  canvas.height = Math.round(cssH * ratio);
  canvas.style.height = `${cssH}px`;
  ctx2d.setTransform(ratio, 0, 0, ratio, 0, 0);
  requestDraw();
}

function requestDraw() {
  if (needsDraw) return;
  needsDraw = true;
  requestAnimationFrame(() => { needsDraw = false; draw(); });
}

const plotW = () => Math.max(cssW - LABEL_W - 12, 40);
const toPx = t => LABEL_W + ((t - state.view.from) / (state.view.to - state.view.from)) * plotW();
const toT = px => state.view.from + ((px - LABEL_W) / plotW()) * (state.view.to - state.view.from);

function tickStep(span, width) {
  const target = (span / width) * 90;
  for (const step of [1e3, 5e3, 15e3, 3e4, 6e4, 3e5, 6e5, 18e5, 36e5, 72e5, 216e5]) if (step >= target) return step;
  return 864e5;
}

function draw() {
  const { tl, session, colors: c, view, detailed } = state;
  if (!tl || !session) return;
  const g = ctx2d;
  g.clearRect(0, 0, cssW, cssH);
  const rowsBottom = TOP_H + tl.rows.length * LANE_H;
  const ctxTop = rowsBottom + 4;
  const ctxBottom = detailed ? ctxTop + CTX_H - 14 : rowsBottom;

  tl.rows.forEach((_, i) => {
    if (i % 2) return;
    g.fillStyle = c.alt; g.globalAlpha = .4;
    g.fillRect(0, TOP_H + i * LANE_H, cssW, LANE_H);
    g.globalAlpha = 1;
  });

  g.font = `11px ${c.mono}`;
  g.textBaseline = 'middle';
  const step = tickStep(view.to - view.from, plotW());
  for (let t = Math.ceil(view.from / step) * step; t <= view.to; t += step) {
    const px = toPx(t);
    if (px < LABEL_W) continue;
    g.strokeStyle = c.line;
    g.beginPath(); g.moveTo(px + .5, TOP_H); g.lineTo(px + .5, ctxBottom); g.stroke();
    g.fillStyle = c.muted;
    g.fillText(t === 0 ? '0' : dur(t).replace(/ 0s$/, ''), px + 3, 10);
  }

  g.save();
  g.beginPath(); g.rect(LABEL_W, 0, cssW - LABEL_W, cssH); g.clip();

  for (const gap of tl.gaps) {
    const a = toPx(gap.x), b = toPx(gap.x + GAP_SHOWN_MS);
    if (b < LABEL_W || a > cssW) continue;
    g.fillStyle = c.line; g.globalAlpha = .55;
    g.fillRect(a, TOP_H, Math.max(b - a, 2), ctxBottom - TOP_H);
    g.globalAlpha = 1;
    if (b - a > 34) {
      // The label is wider than the gap, so it covers any tick label beneath it.
      const label = `${dur(gap.ms)} pause`;
      const labelW = g.measureText(label).width + 8;
      g.fillStyle = c.bg;
      g.fillRect((a + b - labelW) / 2, 2, labelW, TOP_H - 4);
      g.fillStyle = c.text;
      g.textAlign = 'center';
      g.fillText(label, (a + b) / 2, TOP_H - 9);
      g.textAlign = 'left';
    }
  }

  const events = session.events;
  const q = state.filterActive ? state.filteredSet : null;
  const lastCell = new Map();
  for (let i = 0; i < events.length; i++) {
    const a = toPx(tl.x[i]);
    if (a > cssW) break;
    const row = tl.row[i];
    if (row < 0) continue;
    const b = toPx(tl.x[i] + tl.w[i]);
    if (b < LABEL_W - 4) continue;
    const e = events[i];
    const y = TOP_H + row * LANE_H + 3;
    const width = Math.max(b - a, 2.5);
    const isErr = e.tool?.isError;
    // With thousands of events most bars share a pixel. Skip those, but keep errors visible.
    if (!isErr && width <= 3 && lastCell.get(row) === Math.round(a)) continue;
    lastCell.set(row, Math.round(a));
    g.globalAlpha = q && !q.has(i) ? .16 : e.sidechain ? .55 : 1;
    g.fillStyle = isErr ? c.bad : c.lane[tl.rows[row].color];
    g.fillRect(a, y, width, LANE_H - 6);
  }
  g.globalAlpha = 1;

  if (detailed && tl.ctx.length) {
    // Memory in use per request, with cost so far as a line on top.
    const yOf = v => ctxBottom - (v / tl.peak) * (ctxBottom - ctxTop);
    g.beginPath();
    g.moveTo(toPx(tl.ctx[0].x), ctxBottom);
    let last = ctxBottom;
    for (const p of tl.ctx) {
      const px = toPx(p.x);
      g.lineTo(px, last);
      last = yOf(p.size);
      g.lineTo(px, last);
    }
    g.lineTo(toPx(tl.total), last);
    g.lineTo(toPx(tl.total), ctxBottom);
    g.closePath();
    g.fillStyle = c.lane.read; g.globalAlpha = .3; g.fill(); g.globalAlpha = 1;

    const totalCost = tl.cumCost[events.length - 1];
    if (totalCost > 0) {
      g.beginPath();
      let started = false;
      for (const p of tl.ctx) {
        const px = toPx(p.x), py = ctxBottom - (tl.cumCost[p.i] / totalCost) * (ctxBottom - ctxTop);
        if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
      }
      g.strokeStyle = c.accent; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1;
    }
  }
  for (let i = 0; i < events.length; i++) {
    const usageStop = events[i].limit?.type === 'usage';
    if (!usageStop && !(detailed && events[i].kind === 'compact')) continue;
    const px = toPx(tl.x[i]);
    g.strokeStyle = usageStop ? c.lane.limit : c.lane.system;
    g.lineWidth = usageStop ? 2 : 1;
    g.setLineDash(usageStop ? [] : [3, 3]);
    g.beginPath(); g.moveTo(px, TOP_H); g.lineTo(px, ctxBottom); g.stroke();
    g.setLineDash([]);
    g.lineWidth = 1;
  }

  const phX = toPx(state.playing ? state.playT : tl.x[state.selected]);
  g.strokeStyle = c.accent; g.lineWidth = 2;
  g.beginPath(); g.moveTo(phX, 2); g.lineTo(phX, ctxBottom); g.stroke();
  g.lineWidth = 1;
  g.fillStyle = c.accent;
  g.beginPath(); g.moveTo(phX - 5, 1); g.lineTo(phX + 5, 1); g.lineTo(phX, 9); g.closePath(); g.fill();

  g.restore();

  g.fillStyle = c.bg;
  g.fillRect(0, 0, LABEL_W, cssH);
  g.font = `12px ${c.sans}`;
  tl.rows.forEach((row, i) => {
    g.fillStyle = c.muted;
    g.fillText(row.label, 16, TOP_H + i * LANE_H + LANE_H / 2);
  });
  if (detailed) {
    g.fillStyle = c.muted;
    g.fillText('Context', 16, ctxTop + 8);
    g.font = `10.5px ${c.mono}`;
    g.fillText(compact(tl.peak), 16, ctxTop + 22);
    g.fillStyle = c.accent;
    g.fillText('cost', 16, ctxTop + 36);
  }
}

function hitTest(px, py) {
  const { tl, session } = state;
  const wanted = Math.floor((py - TOP_H) / LANE_H);
  const inRows = wanted >= 0 && wanted < tl.rows.length;
  let best = -1, bestDist = 7;
  for (let i = 0; i < session.events.length; i++) {
    if (tl.row[i] < 0 || (inRows && tl.row[i] !== wanted)) continue;
    const a = toPx(tl.x[i]), b = Math.max(toPx(tl.x[i] + tl.w[i]), a + 2.5);
    const d = px < a ? a - px : px > b ? px - b : 0;
    if (d < bestDist || (d === bestDist && session.events[i].tool?.isError)) { best = i; bestDist = d; }
    if (a > px + 10) break;
  }
  return best;
}

function nearestAt(t) {
  const { tl } = state;
  let lo = 0, hi = tl.x.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl.x[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function clampView(from, to) {
  const { total } = state.tl;
  const pad = total * .01;
  const span = Math.min(Math.max(to - from, 1500), total + pad * 2);
  from = Math.min(Math.max(from, -pad), total + pad - span);
  state.view = { from, to: from + span };
  requestDraw();
}

function fitView() {
  const pad = state.tl.total * .01;
  state.view = { from: -pad, to: state.tl.total + pad };
  requestDraw();
}

let drag = null;
canvas.addEventListener('pointerdown', ev => {
  canvas.setPointerCapture(ev.pointerId);
  drag = { x: ev.offsetX, from: state.view.from, to: state.view.to, moved: false };
});
canvas.addEventListener('pointermove', ev => {
  if (drag) {
    const dx = ev.offsetX - drag.x;
    if (Math.abs(dx) > 3) drag.moved = true;
    if (drag.moved) {
      const dt = (dx / plotW()) * (drag.to - drag.from);
      clampView(drag.from - dt, drag.to - dt);
    }
    hideTip();
    return;
  }
  const i = ev.offsetX > LABEL_W ? hitTest(ev.offsetX, ev.offsetY) : -1;
  if (i < 0) { hideTip(); return; }
  const e = state.session.events[i];
  showTip(`${stepTitle(e)}${e.durationMs ? ` · ${dur(e.durationMs)}` : ''}${e.tool?.isError ? ' · failed' : ''}`, ev.clientX, ev.clientY);
});
canvas.addEventListener('pointerleave', hideTip);
canvas.addEventListener('pointerup', ev => {
  const wasDrag = drag?.moved;
  drag = null;
  if (wasDrag || ev.offsetX <= LABEL_W) return;
  pause();
  const hit = hitTest(ev.offsetX, ev.offsetY);
  select(hit >= 0 ? hit : nearestAt(toT(ev.offsetX)), { reveal: false });
});
canvas.addEventListener('wheel', ev => {
  if (!state.tl) return;
  // Plain scrolling must keep moving the page, so zooming needs Ctrl or a pinch.
  if (!ev.ctrlKey && !ev.metaKey && Math.abs(ev.deltaX) <= Math.abs(ev.deltaY)) return;
  ev.preventDefault();
  if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
    const dt = (ev.deltaX / plotW()) * (state.view.to - state.view.from);
    clampView(state.view.from + dt, state.view.to + dt);
    return;
  }
  const factor = Math.exp(ev.deltaY * .004);
  const anchor = toT(ev.offsetX);
  clampView(anchor - (anchor - state.view.from) * factor, anchor + (state.view.to - anchor) * factor);
}, { passive: false });

/* ---------- selection and playback ---------- */

function select(i, { reveal = true, fromPlayback = false } = {}) {
  const { session, tl } = state;
  if (!session) return;
  i = Math.max(0, Math.min(i, session.events.length - 1));
  state.selected = i;
  if (!fromPlayback) state.playT = tl.x[i];
  renderReadout();
  renderInspector();
  renderLogRows();
  if (reveal) { revealInLog(i); revealInChart(tl.x[i]); }
  requestDraw();
}

function revealInChart(t) {
  const { from, to } = state.view;
  const span = to - from;
  if (t < from + span * .02 || t > to - span * .02) clampView(t - span * .3, t + span * .7);
}

function play() {
  const { tl } = state;
  if (state.selected >= tl.x.length - 1) state.selected = 0;
  state.playT = tl.x[state.selected];
  state.playing = true;
  syncPlayButton();
  let previous = performance.now();
  const tick = now => {
    if (!state.playing || !state.session) return;
    const speed = Number($('speed').value);
    state.playT += ((now - previous) * speed * tl.total) / REPLAY_MS;
    previous = now;
    if (state.playT >= tl.total) {
      state.playT = tl.total;
      select(tl.x.length - 1);
      pause();
      return;
    }
    const i = nearestAt(state.playT);
    if (i !== state.selected) select(i, { reveal: true, fromPlayback: true });
    else { revealInChart(state.playT); requestDraw(); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  syncPlayButton();
  requestDraw();
}

function syncPlayButton() {
  $('play').textContent = state.playing ? '❚❚ Pause' : '▶ Replay';
}

function renderReadout() {
  const { tl, session, selected: i, detailed } = state;
  const e = session.events[i];
  const parts = [`Step ${count(i + 1)} of ${count(session.events.length)}  ·  `, h('b', {}, clockTime(e.ts)), '  ·  ', h('b', {}, money(tl.cumCost[i])), ' so far'];
  if (detailed) parts.push('  ·  context ', h('b', {}, compact(contextAt(i))), '  ·  lines ', h('b', {}, `+${tl.cumLinesAdd[i]} -${tl.cumLinesDel[i]}`));
  $('readout').replaceChildren(...parts);
}

function jumpNextError() {
  const { events } = state.session;
  for (let k = 1; k <= events.length; k++) {
    const i = (state.selected + k) % events.length;
    if (events[i].tool?.isError) { pause(); select(i); return; }
  }
}

/* ---------- header, tabs ---------- */

function kpi(value, label, bad) {
  return h('div', {}, h('div', { class: `kpi-value${bad ? ' bad' : ''}` }, value), h('div', { class: 'kpi-label' }, label));
}

function verdict(s, a) {
  const t = a.totals;
  const parts = [`${AGENTS[s.agent] ?? 'The agent'} worked for ${dur(t.activeMs)}, took ${plural(t.toolCalls, 'action')} and changed ${plural(t.filesChanged, 'file')}.`];
  if (t.limitHits) parts.push(`A usage limit stopped it ${t.limitHits === 1 ? 'once' : `${t.limitHits} times`}.`);
  const serious = a.findings.filter(f => f.severity === 'high').length;
  parts.push(serious ? `${plural(serious, 'problem')} need${serious === 1 ? 's' : ''} your attention.` : 'Nothing serious stood out.');
  return parts.join(' ');
}

function renderHead() {
  const { session: s, analysis: a, detailed } = state;
  const t = a.totals;
  $('title').textContent = s.title;
  document.title = `${s.title} · Flight Recorder`;
  $('verdict').textContent = verdict(s, a);
  $('subtitle').textContent = [
    s.project && baseName(s.project), detailed && s.models.join(', '), detailed && s.branch, fullDate(s.startedAt),
  ].filter(Boolean).join(' · ');
  $('detail-toggle').textContent = detailed ? 'Hide technical details' : 'Show technical details';
  const cost = t.hasUnpricedUsage && t.costUsd === 0 ? 'n/a' : `${money(t.costUsd)}${t.hasUnpricedUsage ? '+' : ''}`;
  $('kpis').replaceChildren(...[
    kpi(cost, t.hasUnpricedUsage ? 'cost, some models have no known price' : 'estimated cost'),
    t.wastedUsd > 0 ? kpi(money(t.wastedUsd), 'could be saved', true) : null,
    kpi(dur(t.activeMs), detailed ? `active of ${dur(t.wallMs)}` : 'time working'),
    kpi(count(t.filesChanged), `files changed${t.linesAdded || t.linesRemoved ? `, +${count(t.linesAdded)} -${count(t.linesRemoved)}` : ''}`),
    kpi(count(t.toolErrors), `of ${count(t.toolCalls)} actions failed`, t.toolCalls > 0 && t.toolErrors / t.toolCalls > .2),
    t.limitHits ? kpi(count(t.limitHits), `limit ${t.limitHits === 1 ? 'stop' : 'stops'}, ${dur(t.stalledMs)} waiting`, true) : null,
    detailed ? kpi(compact(t.input + t.cacheRead + t.cacheWrite + t.output), `tokens, ${Math.round(t.cacheHitRate * 100)}% cached input`) : null,
    detailed && t.limitRetries ? kpi(count(t.limitRetries), 'rate or overload errors') : null,
    ...a.quota.map(q => kpi(`${Math.round(q.usedPercent)}%`, `of ${q.label} limit used`, q.usedPercent >= 80)),
  ].filter(Boolean));
}

function jumpButton(cls, onclick, ...children) {
  return h('button', { class: `item ${cls}`, type: 'button', onclick }, ...children);
}

function goTo(i) {
  pause();
  select(i);
  canvas.focus({ preventScroll: true });
}

function findingItem(f) {
  let next = 0;
  const jump = f.eventIds.length > 1 ? h('div', { class: 'finding-jump' }, `Show on the timeline (${count(f.eventIds.length)} steps)`) : h('div', { class: 'finding-jump' }, 'Show on the timeline');
  return jumpButton(`finding ${f.severity}`, () => {
    if (!f.eventIds.length) return;
    // Repeated clicks walk through every step behind a finding.
    goTo(f.eventIds[next]);
    jump.textContent = f.eventIds.length > 1 ? `Step ${count(next + 1)} of ${count(f.eventIds.length)}. Click for the next one.` : 'Show on the timeline';
    next = (next + 1) % f.eventIds.length;
  },
    h('div', { class: 'finding-title' }, f.title),
    h('div', { class: 'finding-detail' }, f.detail),
    f.advice ? h('div', { class: 'finding-advice' }, `What to do: ${f.advice}`) : null,
    jump,
  );
}

function renderTabs() {
  const { analysis: a, detailed } = state;
  const tabs = [
    { id: 'findings', label: 'Things to check', n: a.findings.length },
    { id: 'turns', label: 'Your requests', n: a.turns.length },
    { id: 'files', label: 'Files', n: a.files.length },
  ];
  if (detailed) tabs.push({ id: 'tools', label: 'Tools', n: a.tools.length });
  if (!tabs.some(t => t.id === state.tab)) state.tab = 'findings';
  document.querySelector('.tabs').replaceChildren(...tabs.map(t => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(t.id === state.tab),
    onclick: () => { state.tab = t.id; renderTabs(); },
  }, t.label, h('span', { class: 'count' }, count(t.n)))));

  const body = $('tab-body');
  if (state.tab === 'findings') {
    if (!a.findings.length) {
      body.replaceChildren(h('div', { class: 'none' }, '✓ Nothing to check in this session.'));
      return;
    }
    body.replaceChildren(...GROUPS.flatMap(group => {
      const items = a.findings.filter(f => group.severities.includes(f.severity));
      return items.length ? [h('div', { class: 'group-label' }, group.label), ...items.map(findingItem)] : [];
    }));
  } else if (state.tab === 'turns') {
    body.replaceChildren(...(a.turns.length ? a.turns.map(t => jumpButton('', () => goTo(t.eventId),
      h('div', { class: 'row-main' }, t.prompt),
      h('div', { class: 'row-sub' }, h('span', {}, money(t.costUsd)), h('span', {}, plural(t.tools, 'action')),
        t.errors ? h('span', { class: 'del' }, `${count(t.errors)} failed`) : null, h('span', {}, dur(t.endTs - t.startTs))),
    )) : [h('div', { class: 'none' }, 'No requests in this session.')]));
  } else if (state.tab === 'files') {
    body.replaceChildren(...(a.files.length ? a.files.map(f => jumpButton('', () => goTo(f.eventIds[0]),
      h('div', { class: 'row-main', title: f.path }, baseName(f.path)),
      h('div', { class: 'row-sub' }, f.edits ? h('span', {}, plural(f.edits, 'edit')) : null, f.reads ? h('span', {}, plural(f.reads, 'read')) : null,
        f.added ? h('span', { class: 'add' }, `+${count(f.added)}`) : null, f.removed ? h('span', { class: 'del' }, `-${count(f.removed)}`) : null),
    )) : [h('div', { class: 'none' }, 'No files touched.')]));
  } else {
    body.replaceChildren(...(a.tools.length ? a.tools.map(t => jumpButton('', () => goTo(state.session.events.findIndex(e => e.tool?.name === t.name)),
      h('div', { class: 'row-main' }, t.name),
      h('div', { class: 'row-sub' }, h('span', {}, plural(t.count, 'call')), t.errors ? h('span', { class: 'del' }, `${count(t.errors)} failed`) : null, h('span', {}, dur(t.totalMs))),
    )) : [h('div', { class: 'none' }, 'No tools used.')]));
  }
}

/* ---------- step list (technical view) ---------- */

function applyFilter() {
  const { events } = state.session;
  const query = $('log-search').value.trim().toLowerCase();
  const lane = $('lane-filter').value;
  const errorsOnly = $('errors-only').checked;
  const list = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (lane && e.lane !== lane) continue;
    if (errorsOnly && !e.tool?.isError) continue;
    if (query) {
      const hay = `${e.title}\n${e.text ?? ''}\n${e.tool?.command ?? ''}\n${e.tool?.file?.path ?? ''}\n${e.tool?.output ?? ''}`.toLowerCase();
      if (!hay.includes(query)) continue;
    }
    list.push(i);
  }
  state.filtered = list;
  state.filterActive = Boolean(query || lane || errorsOnly);
  state.filteredSet = new Set(list);
  $('log-spacer').style.height = `${list.length * LOG_ROW}px`;
  renderLogRows();
  requestDraw();
}

function renderLogRows() {
  if (!state.detailed) return;
  const scroll = $('log-scroll');
  const rows = $('log-rows');
  const { filtered, session, selected } = state;
  if (!filtered.length) {
    rows.style.transform = '';
    rows.replaceChildren(h('div', { class: 'none' }, 'No matching steps.'));
    return;
  }
  const first = Math.max(Math.floor(scroll.scrollTop / LOG_ROW) - 8, 0);
  const shown = Math.ceil(scroll.clientHeight / LOG_ROW) + 16;
  rows.style.transform = `translateY(${first * LOG_ROW}px)`;
  rows.replaceChildren(...filtered.slice(first, first + shown).map(i => {
    const e = session.events[i];
    return h('button', {
      class: `ev${i === selected ? ' active' : ''}${e.sidechain ? ' side' : ''}`, type: 'button',
      onclick: () => { pause(); select(i, { reveal: false }); revealInChart(state.tl.x[i]); },
    },
      h('span', { class: 'ev-time' }, clockTime(e.ts)),
      laneDot(e.lane),
      h('span', { class: 'ev-title' }, e.title),
      e.tool?.isError ? h('span', { class: 'ev-err', title: 'Failed' }, '✕') : null,
    );
  }));
}

function laneDot(lane) {
  const pip = h('span', { class: 'ev-pip', title: LANES[lane] });
  pip.style.background = `var(--lane-${lane})`;
  return pip;
}

function revealInLog(i) {
  if (!state.detailed) return;
  const pos = state.filtered.indexOf(i);
  if (pos < 0) return;
  const scroll = $('log-scroll');
  const y = pos * LOG_ROW;
  if (y < scroll.scrollTop) scroll.scrollTop = y;
  else if (y + LOG_ROW > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = y - scroll.clientHeight / 2;
}

/* ---------- step details ---------- */

/** Says in plain words what a step was. Technical view keeps the raw title. */
function stepTitle(e) {
  if (state.detailed) return e.title;
  const t = e.tool;
  if (!t) {
    if (e.kind === 'prompt') return `You asked: ${e.title}`;
    if (e.kind === 'text') return `The agent said: ${e.title}`;
    if (e.kind === 'thinking') return 'The agent was thinking';
    if (e.kind === 'compact') return 'The agent summarized its memory to free up space';
    return e.title;
  }
  const name = t.file ? baseName(t.file.path) : '';
  if (t.file?.op === 'read') return `Read ${name}`;
  if (t.file?.op === 'create') return `Wrote ${name}`;
  if (t.file) return `Edited ${name}`;
  if (t.command) return `Ran a command: ${t.command.split('\n')[0].slice(0, 90)}`;
  if (e.lane === 'search') return 'Searched the project';
  if (e.lane === 'web') return 'Looked something up online';
  if (e.lane === 'agent') return 'Handed a task to a helper agent';
  return e.title;
}

function diffBlock(text) {
  return h('pre', {}, text.split('\n').map(line => {
    const cls = line.startsWith('@@') ? 'hunk' : line[0] === '+' ? 'plus' : line[0] === '-' ? 'minus' : '';
    return h('span', { class: `diff-line ${cls}` }, line || ' ');
  }));
}

function renderInspector() {
  const { session, selected, tl, detailed } = state;
  const e = session.events[selected];
  const parts = [h('h2', { class: 'insp-title' }, stepTitle(e))];
  parts.push(h('div', { class: 'insp-meta' }, [
    h('span', {}, clockTime(e.ts)),
    detailed ? h('span', {}, `+${dur(tl.x[selected])}`) : null,
    detailed ? h('span', {}, LANES[e.lane]) : null,
    e.durationMs ? h('span', {}, `took ${dur(e.durationMs)}`) : null,
    e.sidechain ? h('span', {}, detailed ? `subagent ${e.sidechain}` : 'by a helper agent') : null,
    e.tool?.isError ? h('span', { class: 'badge-err' }, '✕ Failed') : null,
    e.tool && !e.tool.completed ? h('span', {}, 'no result recorded') : null,
    detailed && e.costUsd !== undefined ? h('span', {}, money(e.costUsd)) : null,
  ]));

  if (detailed && e.usage) {
    const u = e.usage;
    parts.push(h('div', { class: 'insp-meta' }, [
      e.model && h('span', {}, e.model),
      h('span', {}, `in ${compact(u.input)}`),
      h('span', {}, `cache read ${compact(u.cacheRead)}`),
      h('span', {}, `cache write ${compact(u.cacheWrite5m + u.cacheWrite1h)}`),
      h('span', {}, `out ${compact(u.output)}`),
    ]));
  }
  const section = (label, node) => { parts.push(h('div', { class: 'insp-label' }, label), node); };

  if (e.limit) {
    parts.push(h('div', { class: 'insp-meta' }, [
      h('span', { class: 'badge-err' }, e.limit.type === 'usage' ? scopeName(e.limit.scope) : LIMIT_TYPES[e.limit.type]),
      e.limit.resetsAt ? h('span', {}, `resets ${fullDate(e.limit.resetsAt)}`) : null,
      detailed && e.limit.status ? h('span', {}, `HTTP ${e.limit.status}`) : null,
    ]));
  }
  if (e.kind === 'compact') {
    const c = e.compact ?? {};
    parts.push(h('p', { class: 'prose' }, `Its working memory went from ${compact(c.preTokens ?? 0)} to ${compact(c.postTokens ?? 0)} tokens, so it may have forgotten some earlier details.`));
  } else if (e.text) {
    parts.push(h('p', { class: 'prose' }, e.text));
  } else if (e.kind === 'thinking') {
    parts.push(h('p', { class: 'prose' }, 'The AI model did not record its reasoning for this step.'));
  }

  if (e.tool) {
    const t = e.tool;
    if (t.command) section('Command', h('pre', {}, t.command));
    if (t.file) section(t.file.op === 'read' ? 'File' : `File (+${t.file.added} -${t.file.removed} lines)`, h('pre', {}, t.file.path));
    if (t.diff) section('What changed', diffBlock(t.diff));
    if (t.output) section(t.isError ? 'Error message' : 'Result', h('pre', {}, t.output));
    if (detailed && !t.command && !t.diff && t.input && t.input !== '{}') section('Input', h('pre', {}, t.input));
  }
  const box = $('inspector');
  box.replaceChildren(...parts);
  box.scrollTop = 0;
}

/* ---------- loading and routing ---------- */

function applyDetailMode() {
  document.body.classList.toggle('detailed', state.detailed);
  if (!state.session || !state.session.events.length) return;
  const selected = state.selected;
  state.tl = buildTimeline(state.session);
  if (!state.detailed) {
    $('log-search').value = '';
    $('lane-filter').value = '';
    $('errors-only').checked = false;
  }
  $('lane-filter').replaceChildren(h('option', { value: '' }, 'All'), ...state.tl.rows.map(r => h('option', { value: r.color }, r.label)));
  resizeChart();
  fitView();
  renderHead();
  renderTabs();
  applyFilter();
  select(selected, { reveal: false });
}

function showSession(payload) {
  pause();
  state.session = payload.session;
  state.analysis = payload.analysis;
  state.selected = 0;
  if (!payload.session.events.length) {
    showEmpty('This session has no steps.', 'The log exists, but nothing in it could be replayed.');
    return;
  }
  showOnly('workspace');
  // A link ending in @<n> opens at that step, so a moment can be shared.
  const linked = location.hash.match(/@(\d+)$/);
  state.selected = linked ? Math.min(Number(linked[1]), payload.session.events.length - 1) : 0;
  applyDetailMode();
  $('log-scroll').scrollTop = 0;
  if (linked) revealInChart(state.tl.x[state.selected]);
}

const redactParam = () => ($('redact').checked ? '' : '?redact=0');

async function loadSessionByKey(key) {
  state.key = key;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(key)}${redactParam()}`);
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error);
    if (state.key === key) showSession(payload);
  } catch (error) {
    showEmpty('Could not open this session.', error.message);
  }
}

function route() {
  const key = decodeURIComponent(location.hash.slice(1).split('@')[0]);
  if (key && state.summaries.some(s => s.key === key)) loadSessionByKey(key);
  else renderOverview();
}

async function loadList() {
  const res = await fetch(`/api/sessions${redactParam()}`);
  state.summaries = await res.json();
  if (!state.summaries.length) {
    showEmpty('No sessions found yet.', 'Looked in ~/.claude/projects, ~/.codex/sessions and ~/.gemini/tmp.', 'Use a coding agent first, or run flightrec --demo to see an example.');
    return;
  }
  route();
}

/* ---------- events ---------- */

$('play').addEventListener('click', () => (state.playing ? pause() : play()));
$('prev').addEventListener('click', () => { pause(); select(state.selected - 1); });
$('next').addEventListener('click', () => { pause(); select(state.selected + 1); });
$('next-error').addEventListener('click', jumpNextError);
$('zoom-reset').addEventListener('click', fitView);
$('log-search').addEventListener('input', applyFilter);
$('lane-filter').addEventListener('change', applyFilter);
$('errors-only').addEventListener('change', applyFilter);
$('log-scroll').addEventListener('scroll', () => requestAnimationFrame(renderLogRows), { passive: true });
$('redact').addEventListener('change', () => { if (!embedded) loadList(); });
$('detail-toggle').addEventListener('click', () => {
  state.detailed = !state.detailed;
  try {
    localStorage.setItem('flightrec.detailed', state.detailed ? '1' : '0');
  } catch {
    // Only a convenience: the view just resets next time.
  }
  applyDetailMode();
});
window.addEventListener('hashchange', () => { if (!embedded) route(); });
window.addEventListener('resize', resizeChart);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); requestDraw(); });

document.addEventListener('keydown', ev => {
  if (!state.session || !state.tl || $('workspace').hidden) return;
  const tag = ev.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (ev.key === 'Escape') ev.target.blur();
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const zoom = factor => {
    const anchor = state.tl.x[state.selected];
    clampView(anchor - (anchor - state.view.from) * factor, anchor + (state.view.to - anchor) * factor);
  };
  const actions = {
    ' ': () => (state.playing ? pause() : play()),
    ArrowLeft: () => { pause(); select(state.selected - 1); },
    ArrowRight: () => { pause(); select(state.selected + 1); },
    Home: () => { pause(); select(0); },
    End: () => { pause(); select(state.session.events.length - 1); },
    e: jumpNextError,
    '+': () => zoom(.7),
    '=': () => zoom(.7),
    '-': () => zoom(1.4),
    0: fitView,
  };
  if (state.detailed) actions['/'] = () => $('log-search').focus();
  const action = actions[ev.key];
  if (!action) return;
  // Space on a focused button should still press that button.
  if (ev.key === ' ' && tag === 'BUTTON') return;
  ev.preventDefault();
  action();
});

readColors();
syncPlayButton();
document.body.classList.toggle('detailed', state.detailed);
if (embedded) {
  $('app').classList.add('solo');
  showSession(embedded);
} else {
  loadList().catch(error => showEmpty('Could not load sessions.', error.message));
}
