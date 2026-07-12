/**
 * CronJob interface and CronContext type for the cron server.
 */

import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';

export interface CronContext {
  prisma: PrismaClient;
  broadcastUrl: string;
  emit: (type: string, data: unknown) => Promise<void>;
  defaults: { get: <T>(key: string, fallback: T) => T };
  log: Logger;
}

export interface CronJob {
  /** Unique job identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** SystemDefaults key for the interval */
  intervalKey: string;
  /** Fallback interval in ms if key not found */
  defaultInterval: number;
  /** Called once before the first run */
  setup?(ctx: CronContext): Promise<void>;
  /** The job's main work */
  run(ctx: CronContext): Promise<void>;
  /** Called on shutdown */
  teardown?(): Promise<void>;
}
