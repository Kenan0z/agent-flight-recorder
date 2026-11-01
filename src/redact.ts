import { homedir, hostname, userInfo } from 'node:os';
import type { Session } from './types.js';

interface SecretRule {
  label: string;
  re: RegExp;
  /** Capture group holding the secret. The whole match is replaced if omitted. */
  group?: number;
}

const SECRET_RULES: SecretRule[] = [
  { label: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { label: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { label: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { label: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { label: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { label: 'aws-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { label: 'google-key', re: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { label: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'stripe-key', re: /\b[rs]k_live_[A-Za-z0-9]{16,}/g },
  { label: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { label: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:([^\s/@'"]+)@/gi, group: 1 },
  { label: 'bearer-token', re: /\b(?:authorization\s*[:=]\s*)?bearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi, group: 1 },
  {
    label: 'assigned-secret',
    re: /\b[\w.-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key)[\w.-]*["']?\s*[:=]\s*["']?([^\s"',;]{6,})/gi,
    group: 1,
  },
];

const MARKER = '[REDACTED:';
const CODE_WORDS = /^(string|str|bool|boolean|number|int|none|null|true|false|undefined|required|optional|process\.env.*|os\.environ.*|self\..*|this\..*|config\..*|settings\..*|args\..*|options\..*)$/i;

function applyRule(text: string, rule: SecretRule): string {
  return text.replace(rule.re, (match, ...args) => {
    const marker = `${MARKER}${rule.label}]`;
    if (rule.group === undefined) return marker;
    const secret = args[rule.group - 1] as string;
    // Skip values already masked, placeholders, and code such as `password = getpass()`.
    if (secret.startsWith(MARKER) || /^[$<{%]/.test(secret)) return match;
    if (rule.label === 'assigned-secret' && (/[()[\]{}<>=]/.test(secret) || CODE_WORDS.test(secret))) return match;
    return match.replace(secret, marker);
  });
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of SECRET_RULES) out = applyRule(out, rule);
  return out;
}

/** True if text holds something that looks like a credential, masked or not. */
export function containsSecret(text: string): boolean {
  return text.includes(MARKER) || redactSecrets(text) !== text;
}

function identityScrubber(): (text: string) => string {
  const home = homedir();
  const homes = [home, home.replaceAll('\\', '\\\\'), home.replaceAll('\\', '/')];
  const words = [userInfo().username, hostname()]
    .filter(w => w.length >= 3)
    .map(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'));
  return text => {
    let out = text;
    for (const h of homes) out = out.replaceAll(h, '~');
    for (const w of words) out = out.replace(w, 'user');
    return out.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[REDACTED:email]');
  };
}

/** Masks one string with the same rules as redactSession. */
export function redactText(text: string): string {
  return identityScrubber()(redactSecrets(text));
}

/**
 * Returns a copy that is safer to share: credentials, emails, the home
 * directory, the OS user name and the host name are masked. Pattern matching
 * is best effort and cannot promise that a transcript is free of private data.
 */
export function redactSession(session: Session): Session {
  const scrub = identityScrubber();
  const clean = (text: string) => scrub(redactSecrets(text));
  const opt = <T extends string | undefined>(text: T) => (text === undefined ? text : clean(text)) as T;
  return {
    ...session,
    title: clean(session.title),
    project: opt(session.project),
    branch: opt(session.branch),
    events: session.events.map(e => ({
      ...e,
      title: clean(e.title),
      text: opt(e.text),
      tool: e.tool && {
        ...e.tool,
        input: opt(e.tool.input),
        output: opt(e.tool.output),
        command: opt(e.tool.command),
        diff: opt(e.tool.diff),
        file: e.tool.file && { ...e.tool.file, path: clean(e.tool.file.path) },
      },
    })),
  };
}
