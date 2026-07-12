/**
 * Cron Server Entry Point
 * Runs background jobs: native price sync, social sync.
 * Connects to the same DB as the wallet server.
 */

import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { getDbUrl } from '../lib/config';
import { preloadCache, getDefaultSync } from '../lib/defaults';
import { Scheduler } from './scheduler';
import { nativePriceJob } from './jobs/native-price';
import { polymarketScannerJob } from './jobs/polymarket-scanner';
import { socialInboundJob } from './jobs/social-inbound';
import { socialOutboundJob } from './jobs/social-outbound';
import type { CronContext } from './job';

// Set DATABASE_URL before creating PrismaClient
process.env.DATABASE_URL = getDbUrl();

const isDev = process.env.NODE_ENV !== 'production';
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

const log = pino({
  level: isTest ? 'silent' : (process.env.LOG_LEVEL || 'info'),
  ...(isDev && !isTest
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
            messageFormat: '[cron] {msg}',
          },
        },
      }
    : {}),
});

const WS_BROADCAST_URL = process.env.WS_BROADCAST_URL ?? 'http://localhost:4748/broadcast';

async function emit(type: string, data: unknown): Promise<void> {
  if (!WS_BROADCAST_URL) return;

  const event = {
    type,
    timestamp: Date.now(),
    source: 'cron',
    data,
  };

  try {
    const res = await fetch(WS_BROADCAST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      log.warn({ status: res.status, type }, 'WebSocket broadcast failed');
    }
  } catch (err) {
    log.debug({ err, type }, 'WebSocket broadcast unreachable');
  }
}

async function autoMigrate(): Promise<void> {
  const { execSync } = await import('child_process');
  const dbUrl = process.env.DATABASE_URL;
  try {
    execSync('npx prisma migrate deploy', {
      cwd: import.meta.dirname ? import.meta.dirname + '/../..' : process.cwd(),
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'pipe',
    });
    log.info('Database migrations applied');
  } catch {
    log.debug('Database migration skipped (may already be up to date)');
  }
}

async function main(): Promise<void> {
  log.info('AuraMaxx Cron Server starting...');

  // Apply pending migrations
  await autoMigrate();

  // Create Prisma client
  const prisma = new PrismaClient();

  // Load system defaults into cache
  await preloadCache().catch((err) => {
    log.warn({ err }, 'Failed to preload defaults cache');
  });

  // Build context
  const ctx: CronContext = {
    prisma,
    broadcastUrl: WS_BROADCAST_URL,
    emit,
    defaults: {
      get: <T>(key: string, fallback: T): T => getDefaultSync<T>(key, fallback),
    },
    log,
  };

  // Build scheduler
  const scheduler = new Scheduler();
  scheduler.register(nativePriceJob);
  scheduler.register(polymarketScannerJob);
  scheduler.register(socialInboundJob);
  scheduler.register(socialOutboundJob);

  // Start all jobs
  await scheduler.startAll(ctx);

  log.info('Cron server running. Press Ctrl+C to stop.');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down cron server...');
    await scheduler.stopAll();
    await prisma.$disconnect();
    log.info('Cron server stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error({ err }, 'Cron server failed to start');
  process.exit(1);
});
