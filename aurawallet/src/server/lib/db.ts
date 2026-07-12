import { PrismaClient } from '@prisma/client';
import { getDbUrl } from './config';

// The PrismaClient is created lazily on first access.  This prevents the
// module-load-time side-effect that used to run:
//
//   process.env.DATABASE_URL = getDbUrl();       // ← overwrites test env!
//   export const prisma = new PrismaClient();    // ← connects immediately
//
// In tests, workerSetup.ts sets DATABASE_URL to a per-worker path *before*
// test files are imported.  If db.ts eagerly resolves the URL at import time,
// it can race with the worker setup and hit the real ~/.auramaxx/ database.
//
// With a lazy getter the URL is resolved on first query — long after the test
// environment is fully configured.

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const url = getDbUrl();

  // Safety: never let a test worker connect to the real database.
  // The .env file at the project root contains DATABASE_URL pointing to
  // ~/.auramaxx/auramaxx.db. If Prisma's dotenv loading wins the race
  // against workerSetup.ts, we'd silently hit production data.
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    if (!url.includes('test-data') && !url.includes('test.db')) {
      throw new Error(
        `SAFETY: db.ts refusing to connect to non-test database in test mode!\n` +
        `  Resolved URL: ${url}\n` +
        `  Expected a URL containing 'test-data' or 'test.db'.\n` +
        `  Check that workerSetup.ts ran before this module was first accessed.`
      );
    }
  }

  // Keep process.env in sync so other code that reads it directly still works
  process.env.DATABASE_URL = url;
  return new PrismaClient({
    datasources: { db: { url } },
  });
}

let _lazyPrisma: PrismaClient | undefined = globalForPrisma.prisma;

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (!_lazyPrisma) {
      _lazyPrisma = createPrismaClient();
      if (process.env.NODE_ENV !== 'production') {
        globalForPrisma.prisma = _lazyPrisma;
      }
    }
    return Reflect.get(_lazyPrisma, prop, receiver);
  },
});
