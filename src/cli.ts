#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from './analyze.js';
import { buildIndex, discover, loadSession, scanTree, type IndexedSession } from './discover.js';
import { PACKAGE_ROOT, renderExport } from './export.js';
import { BUILTIN_PRICES, type PriceTable } from './pricing.js';
import { redactSession } from './redact.js';
import { printList, printReport } from './report.js';
import { createAppServer } from './server.js';

const HELP = `flightrec - a flight recorder for AI coding agents

Usage
  flightrec                     Open the replay UI in your browser
  flightrec list                List recorded sessions
  flightrec report [session]    Print a summary and findings
  flightrec export [session]    Write a shareable, self-contained HTML file

[session] is "latest" (default) or the start of a session id.

Options
  --demo            Use the bundled demo sessions instead of your logs
  --dir <path>      Also read logs from a folder or file (repeatable)
  --prices <file>   JSON price table, merged over the built-in one
  --json            Machine-readable output (list, report)
  --port <n>        UI port (default 4173)
  --no-open         Do not open a browser
  --no-cache        Re-read every log
  -o, --out <file>  Export path (default flightrec-<id>.html)
  --no-redact       Keep secrets and personal data in an export
  -h, --help        Show this help
  -v, --version     Show the version

Sessions are read from ~/.claude/projects, ~/.codex/sessions and ~/.gemini/tmp.
Nothing ever leaves your machine.
`;

function fail(message: string): never {
  console.error(`flightrec: ${message}`);
  process.exit(1);
}

function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function pick(sessions: IndexedSession[], query = 'latest'): IndexedSession {
  if (!sessions.length) fail('no sessions found. Run an agent first, or try --demo.');
  if (query === 'latest') return sessions[0]!;
  const matches = sessions.filter(s => s.summary.key.startsWith(query));
  if (!matches.length) fail(`no session starts with "${query}". See: flightrec list`);
  if (matches.length > 1) fail(`"${query}" matches ${matches.length} sessions. Use more characters.`);
  return matches[0]!;
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        demo: { type: 'boolean' },
        dir: { type: 'string', multiple: true },
        prices: { type: 'string' },
        json: { type: 'boolean' },
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        'no-cache': { type: 'boolean' },
        out: { type: 'string', short: 'o' },
        'no-redact': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    fail(`${(error as Error).message}\nSee: flightrec --help`);
  }
  const { values: opts, positionals } = parsed;
  const [command = 'open', target] = positionals;

  if (opts.help) return void console.log(HELP);
  if (opts.version) {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    return void console.log(pkg.version);
  }
  if (!['open', 'list', 'report', 'export'].includes(command)) fail(`unknown command "${command}". See: flightrec --help`);

  let prices: PriceTable | undefined;
  if (opts.prices) {
    try {
      prices = { ...BUILTIN_PRICES, ...JSON.parse(readFileSync(opts.prices, 'utf8')) };
    } catch (error) {
      fail(`could not read --prices file: ${(error as Error).message}`);
    }
  }

  const sources = opts.demo
    ? await scanTree(join(PACKAGE_ROOT, 'fixtures', 'demo'))
    : await discover(opts.dir ?? []);
  const showProgress = process.stderr.isTTY;
  const sessions = await buildIndex(sources, {
    prices,
    useCache: !opts.demo && !opts['no-cache'],
    onProgress: (done, total) => {
      if (showProgress && total > 3) process.stderr.write(`\rReading logs ${done}/${total}${done === total ? '\n' : ''}`);
    },
  });

  if (command === 'list') {
    const rows = sessions.map(s => s.summary);
    if (opts.json) return void console.log(JSON.stringify(rows, null, 2));
    return printList(rows);
  }

  if (command === 'report' || command === 'export') {
    let session = await loadSession(pick(sessions, target).source);
    const shouldRedact = command === 'export' && !opts['no-redact'];
    if (shouldRedact) session = redactSession(session);
    const analysis = analyze(session, prices);
    if (command === 'report') {
      if (opts.json) return void console.log(JSON.stringify({ title: session.title, key: session.key, ...analysis }, null, 2));
      return printReport(session, analysis);
    }
    const out = resolve(opts.out ?? `flightrec-${session.key.slice(0, 8)}.html`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderExport(session, analysis));
    console.log(`Wrote ${out}`);
    console.log(shouldRedact
      ? 'Secrets and personal data were masked on a best-effort basis. Read it through before sharing.'
      : 'WARNING: not redacted. This file contains the full transcript.');
    return;
  }

  const port = opts.port === undefined ? 4173 : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be a number from 0 to 65535');
  const server = createAppServer(sessions, { prices, port });
  let attempt = 0;
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && opts.port === undefined && attempt < 20) {
      server.listen(port + ++attempt, '127.0.0.1');
      return;
    }
    fail(error.message);
  });
  server.on('listening', () => {
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`;
    console.log(`Flight Recorder: ${url}  (${sessions.length} session${sessions.length === 1 ? '' : 's'}, Ctrl+C to stop)`);
    if (!opts['no-open']) openBrowser(url);
  });
  server.listen(port, '127.0.0.1');
}

main().catch(error => fail((error as Error).message));
