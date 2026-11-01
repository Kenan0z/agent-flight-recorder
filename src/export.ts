import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Analysis, Session } from './types.js';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WEB_DIR = join(PACKAGE_ROOT, 'web');

/** Makes text safe to place inside a <script> element. */
function scriptSafe(text: string): string {
  const out = text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  // JSON allows these two line separators, older JavaScript parsers do not.
  return [0x2028, 0x2029].reduce(
    (acc, code) => acc.replaceAll(String.fromCharCode(code), `\\u${code.toString(16)}`),
    out,
  );
}

const EXPORT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

/** Builds one self-contained HTML file. The page cannot load or send anything. */
export function renderExport(session: Session, analysis: Analysis): string {
  const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
  const css = readFileSync(join(WEB_DIR, 'style.css'), 'utf8');
  const js = readFileSync(join(WEB_DIR, 'app.js'), 'utf8');
  const data = JSON.stringify({ session, analysis });
  return html
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, () => `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`)
    .replace(/<link rel="stylesheet"[^>]*>/, () => `<style>${css}</style>`)
    .replace(/<script src="app\.js"[^>]*><\/script>/, () =>
      `<script>window.__FLIGHTREC__=${scriptSafe(data)}</script>\n<script>${scriptSafe(js)}</script>`);
}
