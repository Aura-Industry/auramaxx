/**
 * Shared Pino logger instance for the Express server (port 4242)
 */

import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

export const log = pino({
  level: isTest ? 'silent' : (process.env.LOG_LEVEL || 'debug'),
  ...(isDev && !isTest
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});
