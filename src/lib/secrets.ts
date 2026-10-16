/**
 * Guards for reading user source code: some files must never be read, and secret-looking values
 * are masked before any content is sent to the LLM.
 */

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?$/i, // .env, .env.local … (examples allowed)
  /(^|\/)\.(npmrc|netrc|pypirc|git-credentials|htpasswd|pgpass)$/i,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|ovpn|kdbx)$/i,
  /(^|\/)(credentials|secrets?|service[-_]?account)[^/]*\.(json|ya?ml|toml|ini)$/i,
  /(^|\/)wp-config\.php$/i, // WordPress DB credentials + salts
  /\.(sql|sqlite3?|db|dump|bak|wpress)(\.gz)?$/i, // database dumps / site backups (user data)
  /(^|\/)(debug|error_log|php_errors?)(\.log)?$/i, // WordPress/PHP logs (paths, emails, tokens)
  /(^|\/)wp-content\/(ai1wm-backups|updraft|backups?[^/]*|wflogs)\//i, // backup/security plugin data
  /(^|\/)auth\.json$/i, // composer auth
  /(^|\/)\.aws\/|(^|\/)\.ssh\//i,
];

export function isSensitivePath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  return SENSITIVE_FILE_PATTERNS.some((re) => re.test(p));
}

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style keys
  /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi, // credentials in connection URLs
];

/** `apiKey = "…"`, `"password": "…"` etc. — keep the key name, mask the value. */
const ASSIGNMENT =
  /((?:api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|client[_-]?secret|auth)[\w-]*["']?\s*[:=]\s*)(["'`])([^"'`\s]{8,})\2/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out.replace(ASSIGNMENT, (_m, prefix: string, q: string) => `${prefix}${q}[REDACTED]${q}`);
}
