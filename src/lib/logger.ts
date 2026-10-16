type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const secrets = new Set<string>();

/** Register secret values that must never appear in logs. */
export function registerSecrets(values: string[]): void {
  for (const v of values) if (v) secrets.add(v);
}

/** Replace registered secrets and `key=` query params in arbitrary text. */
export function redact(text: string): string {
  let out = text.replace(/([?&]key=)[^&\s"']+/gi, '$1[REDACTED]');
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Human-readable logs on stderr (stdout is reserved for the report). */
export function createLogger(
  level: Level = 'info',
  write: (line: string) => void = (l) => process.stderr.write(l),
): Logger {
  const min = ORDER[level];
  const log = (lvl: Exclude<Level, 'silent'>, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const time = new Date().toISOString().slice(11, 23);
    const extra = data && Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
    write(redact(`${time} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra}`) + '\n');
  };
  return {
    debug: (m, d) => log('debug', m, d),
    info: (m, d) => log('info', m, d),
    warn: (m, d) => log('warn', m, d),
    error: (m, d) => log('error', m, d),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
