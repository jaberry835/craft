/**
 * Small structured logger for the AAA server.
 *
 * Lines look like `2026-09-25T14:00:00.000Z ERROR [agent-run] Run failed run=… error=…`.
 * `AAA_LOG_LEVEL` selects `error`, `warn` (default), `info`, or `debug`; `AAA_LOG_FORMAT=json`
 * emits one JSON object per line for collectors. Values of environment variables whose
 * names look secret (KEY, SECRET, TOKEN, PASSWORD, CONNECTION_STRING) and bearer tokens are
 * always redacted, so logs are safe to share when debugging.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
type LogContext = Record<string, unknown>;

const levels: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const secretName = /(KEY|SECRET|TOKEN|PASSWORD|CONNECTION_STRING)/i;

function currentLevel(): LogLevel {
  const configured = process.env.AAA_LOG_LEVEL?.trim().toLowerCase();
  return configured && configured in levels ? configured as LogLevel : 'warn';
}

export function logLevelEnabled(level: LogLevel): boolean {
  return levels[level] <= levels[currentLevel()];
}

/** Removes secret environment values and bearer tokens from text. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && secretName.test(name)) result = result.split(value).join('[redacted]');
  }
  return result.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]');
}

/** An error's message followed by its causes, e.g. "fetch failed <- ECONNREFUSED 10.0.0.4:443". */
export function errorDetail(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.filter(Boolean).join(' <- ') || 'unknown error';
}

function serialize(value: unknown): string {
  if (value instanceof Error) return errorDetail(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: LogLevel, area: string, message: string, context: LogContext = {}): void {
  if (!logLevelEnabled(level)) return;
  const time = new Date().toISOString();
  const entries = Object.entries(context).filter(([, value]) => value !== undefined && value !== '');
  let line: string;
  if (process.env.AAA_LOG_FORMAT?.trim().toLowerCase() === 'json') {
    line = JSON.stringify({
      time,
      level,
      area,
      message,
      ...Object.fromEntries(entries.map(([key, value]) => [key, value instanceof Error ? errorDetail(value) : value]))
    });
  } else {
    const details = entries.map(([key, value]) => {
      const text = serialize(value);
      return `${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`;
    });
    line = [time, level.toUpperCase().padEnd(5), `[${area}]`, message, ...details].join(' ');
  }
  line = redactSecrets(line);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  if (level === 'error' && logLevelEnabled('debug')) {
    const stack = Object.values(context).find((value): value is Error => value instanceof Error)?.stack;
    if (stack) console.error(redactSecrets(stack));
  }
}

export const log = {
  error: (area: string, message: string, context?: LogContext) => write('error', area, message, context),
  warn: (area: string, message: string, context?: LogContext) => write('warn', area, message, context),
  info: (area: string, message: string, context?: LogContext) => write('info', area, message, context),
  debug: (area: string, message: string, context?: LogContext) => write('debug', area, message, context)
};
