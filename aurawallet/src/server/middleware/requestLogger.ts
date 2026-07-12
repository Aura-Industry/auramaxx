/**
 * Lightweight request/response logging middleware using Pino
 *
 * Console logging via Pino (structured, with request IDs and timing).
 * Only stores events in DB for errors and security-relevant failures (4xx/5xx).
 * Business events (send, fund, swap, token create, etc.) are logged separately
 * by each route via the logger module, which handles DB + WebSocket storage.
 */

import { randomBytes } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { log } from '../lib/pino';
import { events } from '../lib/events';
import { redactUrlQuery } from '../lib/redaction';

// Paths to skip logging entirely (high-frequency/low-value)
const SKIP_PATHS = new Set(['/health']);

/**
 * Express middleware that logs request/response details via Pino
 * Only persists error/security events to DB to avoid bloat
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_PATHS.has(req.path)) {
    next();
    return;
  }

  const requestId = randomBytes(4).toString('hex');
  const startTime = process.hrtime.bigint();
  const safeUrl = redactUrlQuery(req.originalUrl || req.path);

  const child = log.child({ requestId });

  child.debug({
    method: req.method,
    url: safeUrl,
  }, 'request start');

  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - startTime;
    const durationMs = Number(durationNs) / 1_000_000;
    const statusCode = res.statusCode;

    const logData: Record<string, unknown> = {
      method: req.method,
      url: safeUrl,
      statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    };

    // Add agent identification for authenticated requests
    if (req.auth) {
      logData.agentId = req.auth.token.agentId;
    }

    // Log level based on status code
    if (statusCode >= 500) {
      child.error(logData, 'request error');
    } else if (statusCode >= 400) {
      child.warn(logData, 'request complete');
    } else {
      child.debug(logData, 'request complete');
    }

    // Only persist security-relevant failures to DB (auth failures, forbidden, rate limits, server errors)
    if (statusCode === 401 || statusCode === 403 || statusCode === 429 || statusCode >= 500) {
      const eventType =
        statusCode === 401 ? 'request:auth_failed' :
        statusCode === 403 ? 'request:forbidden' :
        statusCode === 429 ? 'request:rate_limited' :
        'request:server_error';

      events.custom(eventType, {
        requestId,
        method: req.method,
        path: safeUrl,
        statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        agentId: req.auth?.token?.agentId,
      });
    }
  });

  next();
}
