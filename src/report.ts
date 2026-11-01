import type { Analysis, Session, SessionSummary, Severity } from './types.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2), bold = paint(1), red = paint(31), yellow = paint(33), cyan = paint(36);

export function money(n: number, unpriced = false): string {
  if (unpriced && n === 0) return 'n/a';
  return `${unpriced ? '≥' : ''}$${n < 0.01 && n > 0 ? '0.01' : n.toFixed(2)}`;
}

export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

export function printList(rows: SessionSummary[]): void {
  if (!rows.length) {
    console.log('No sessions found. Try: flightrec --demo');
    return;
  }
  console.log(dim(`${'ID'.padEnd(10)}${'WHEN'.padEnd(18)}${'COST'.padStart(9)}${'TOOLS'.padStart(7)}${'ERR'.padStart(5)}${'FLAGS'.padStart(7)}  TITLE`));
  for (const r of rows) {
    const flags = String(r.findings).padStart(7);
    console.log(
      r.key.slice(0, 8).padEnd(10) + stamp(r.startedAt).padEnd(18) +
      money(r.costUsd, r.hasUnpricedUsage).padStart(9) + String(r.toolCalls).padStart(7) +
      String(r.toolErrors).padStart(5) + (r.highFindings ? red(flags) : flags) + '  ' + fit(r.title, 60),
    );
  }
}

const SEVERITY_LABEL: Record<Severity, (s: string) => string> = {
  high: s => red(s), medium: s => yellow(s), low: s => cyan(s), info: s => dim(s),
};

export function printReport(session: Session, analysis: Analysis): void {
  const t = analysis.totals;
  console.log(bold(session.title));
  console.log(dim([session.agent, session.models.join(', '), session.project, session.branch].filter(Boolean).join(' · ')));
  console.log();
  const rows: [string, string][] = [
    ['Estimated cost', money(t.costUsd, t.hasUnpricedUsage)],
    ['Avoidable (est.)', money(t.wastedUsd)],
    ['Duration', `${duration(t.activeMs)} active, ${duration(t.wallMs)} total`],
    ['Tokens', `${compact(t.input + t.cacheRead + t.cacheWrite)} in (${Math.round(t.cacheHitRate * 100)}% from cache), ${compact(t.output)} out`],
    ['Tool calls', `${t.toolCalls} (${t.toolErrors} failed)`],
    ['Files changed', `${t.filesChanged} (+${t.linesAdded} / -${t.linesRemoved})`],
    ['Compactions', String(t.compactions)],
  ];
  if (t.limitHits || t.limitRetries) {
    rows.push(['Limits', `${t.limitHits} stopped the work, ${t.limitRetries} rate or overload errors, ${duration(t.stalledMs)} stalled`]);
  }
  for (const q of analysis.quota) rows.push([`${q.label} limit`, `${Math.round(q.usedPercent)}% used at peak`]);
  for (const [label, value] of rows) console.log(`  ${dim(label.padEnd(18))}${value}`);
  console.log();
  if (!analysis.findings.length) {
    console.log('No findings.');
    return;
  }
  console.log(bold(`Findings (${analysis.findings.length})`));
  for (const f of analysis.findings) {
    const waste = f.wastedUsd ? dim(`  ~${money(f.wastedUsd)}`) : '';
    console.log(`  ${SEVERITY_LABEL[f.severity](f.severity.toUpperCase().padEnd(7))}${f.title}${waste}`);
    console.log(dim(`         ${f.detail}`));
    if (f.advice) console.log(dim(`         What to do: ${f.advice}`));
  }
}
