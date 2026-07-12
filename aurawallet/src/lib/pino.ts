/**
 * Shared logger instance for the WebSocket server (port 4748).
 *
 * This module is imported by the Next.js instrumentation runtime.
 * A static `import pino from 'pino'` can force a vendor chunk that may
 * not exist in stale/incremental `.next` outputs, so we resolve it at runtime
 * and fall back to a minimal console logger when needed.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function parseArgs(args: unknown[]): { data?: unknown; msg?: string } {
  if (args.length === 0) return {};
  if (typeof args[0] === 'string') {
    return { msg: args[0] as string };
  }
  if (typeof args[1] === 'string') {
    return { data: args[0], msg: args[1] as string };
  }
  return { data: args[0] };
}

function createConsoleLogger(bindings: Record<string, unknown> = {}): LoggerLike {
  const emit = (level: Level, args: unknown[]) => {
    const { data, msg } = parseArgs(args);
    const payload = {
      level,
      component: 'ws',
      ...bindings,
      ...(data && typeof data === 'object' ? data as Record<string, unknown> : {}),
      msg,
      time: new Date().toISOString(),
    };

    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(payload);
  };

  return {
    child(extraBindings: Record<string, unknown>) {
      return createConsoleLogger({ ...bindings, ...extraBindings });
    },
    debug(...args: unknown[]) {
      emit('debug', args);
    },
    info(...args: unknown[]) {
      emit('info', args);
    },
    warn(...args: unknown[]) {
      emit('warn', args);
    },
    error(...args: unknown[]) {
      emit('error', args);
    },
  };
}

function createRuntimePinoLogger(): LoggerLike | null {
  try {
    const requireFn = new Function('return require')() as NodeRequire;
    const maybeModule = requireFn('pino') as
      | ((options?: Record<string, unknown>) => LoggerLike)
      | { default?: (options?: Record<string, unknown>) => LoggerLike };
    const pinoFactory =
      typeof maybeModule === 'function' ? maybeModule : maybeModule.default;

    if (!pinoFactory) return null;
    return pinoFactory({ level: process.env.LOG_LEVEL || 'debug' });
  } catch {
    return null;
  }
}

export const log: LoggerLike = createRuntimePinoLogger() ?? createConsoleLogger();
