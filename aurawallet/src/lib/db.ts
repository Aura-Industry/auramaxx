import { PrismaClient } from '@prisma/client';
import path from 'path';
import os from 'os';

// Resolve DATABASE_URL to ~/.auramaxx/auramaxx.db
// Tests and explicit overrides are preserved
const envUrl = process.env.DATABASE_URL;
if (!envUrl || envUrl === 'file:./dev.db') {
  const dbPath = path.join(os.homedir(), '.auramaxx', 'auramaxx.db');
  process.env.DATABASE_URL = `file:${dbPath}`;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
