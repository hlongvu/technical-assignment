import pino, { type Logger as PinoLogger } from 'pino';

export interface LogFields {
  action: string;
  userId?: string;
  traceId?: string;
  [k: string]: unknown;
}

export interface AppLogger {
  debug(fields: LogFields, msg?: string): void;
  info(fields: LogFields, msg?: string): void;
  warn(fields: LogFields, msg?: string): void;
  error(fields: LogFields, msg?: string): void;
  child(bindings: Partial<LogFields>): AppLogger;
}

type Bindings = Record<string, unknown>;

/** Wrap a pino logger into our AppLogger interface (action-first structured logging). */
function wrap(pinoLogger: PinoLogger, defaultBindings: Bindings): AppLogger {
  const childLogger = pinoLogger.child(defaultBindings);
  return {
    debug: (f, m) => childLogger.debug(f, m ?? ''),
    info:  (f, m) => childLogger.info(f, m ?? ''),
    warn:  (f, m) => childLogger.warn(f, m ?? ''),
    error: (f, m) => childLogger.error(f, m ?? ''),
    child: (b) => wrap(pinoLogger, { ...defaultBindings, ...b }),
  };
}

export function createLogger(service: string, level: string = 'info'): AppLogger {
  const pinoLogger = pino({
    name: service,
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
  return wrap(pinoLogger, { service });
}
