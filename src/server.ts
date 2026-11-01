import { createReadStream } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { analyze } from './analyze.js';
import { loadSession, type IndexedSession } from './discover.js';
import { WEB_DIR } from './export.js';
import type { PriceTable } from './pricing.js';
import { redactSession, redactText } from './redact.js';
import type { Analysis, Session } from './types.js';

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const MAX_CACHED_SESSIONS = 4;

export function createAppServer(sessions: IndexedSession[], options: { prices?: PriceTable; port: number }): Server {
  const cache = new Map<string, Session>();

  const load = async (item: IndexedSession): Promise<Session> => {
    const hit = cache.get(item.summary.key);
    if (hit) return hit;
    const session = await loadSession(item.source);
    cache.set(item.summary.key, session);
    if (cache.size > MAX_CACHED_SESSIONS) cache.delete(cache.keys().next().value!);
    return session;
  };

  // Transcripts are private. Only answering to loopback host names stops a
  // malicious site from reaching this server through DNS rebinding. No CORS
  // headers are ever sent, so other origins cannot read responses either.
  const allowedHost = (host: string | undefined) => {
    if (!host) return false;
    const name = host.replace(/:\d+$/, '').toLowerCase();
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
  };

  return createServer(async (req, res) => {
    if (!allowedHost(req.headers.host)) return json(res, 403, { error: 'Forbidden host' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });

    const url = new URL(req.url ?? '/', 'http://localhost');
    const asset = STATIC[url.pathname];
    if (asset) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type });
      createReadStream(join(WEB_DIR, asset.file)).pipe(res);
      return;
    }

    if (url.pathname === '/api/sessions') {
      const redact = url.searchParams.get('redact') !== '0';
      const rows = sessions.map(s => s.summary);
      if (!redact) return json(res, 200, rows);
      return json(res, 200, rows.map(r => ({
        ...r,
        title: redactText(r.title),
        project: r.project && redactText(r.project),
        branch: r.branch && redactText(r.branch),
        topFinding: r.topFinding && redactText(r.topFinding),
      })));
    }

    const match = url.pathname.match(/^\/api\/sessions\/([\w.-]+)$/);
    if (match) {
      const item = sessions.find(s => s.summary.key === match[1]);
      if (!item) return json(res, 404, { error: 'Session not found' });
      try {
        let session = await load(item);
        if (url.searchParams.get('redact') !== '0') session = redactSession(session);
        const analysis: Analysis = analyze(session, options.prices);
        return json(res, 200, { session, analysis });
      } catch (error) {
        return json(res, 500, { error: `Could not read this log: ${(error as Error).message}` });
      }
    }
    return json(res, 404, { error: 'Not found' });
  });
}
