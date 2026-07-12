import { prisma } from './db';
import { CredentialAccessAction, CredentialAccessReasonCode } from './credential-access-policy';

interface WriteCredentialAccessAuditInput {
  credentialId: string;
  credentialAgentId: string;
  action: CredentialAccessAction;
  allowed: boolean;
  reasonCode: CredentialAccessReasonCode;
  httpStatus: number;
  tokenHash?: string;
  actorAgentId?: string;
  requestId?: string;
  actorType: 'agent' | 'admin' | 'unknown';
  projectScope?: string | null;
  metadata?: Record<string, unknown>;
}

function safeJson(value: Record<string, unknown> | undefined): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

export async function writeCredentialAccessAudit(input: WriteCredentialAccessAuditInput): Promise<string> {
  const row = await prisma.credentialAccessAudit.create({
    data: {
      credentialId: input.credentialId,
      agentId: input.credentialAgentId,
      action: input.action,
      allowed: input.allowed,
      result: input.allowed ? 'allow' : 'deny',
      reasonCode: input.reasonCode,
      httpStatus: input.httpStatus,
      tokenHash: input.tokenHash,
      actorAgentId: input.actorAgentId,
      requestId: input.requestId,
      actorType: input.actorType,
      projectScope: input.projectScope ?? null,
      sensitiveRead: true,
      metadata: safeJson(input.metadata),
    },
  });

  return row.id;
}

export async function listRecentCredentialAccess(limit = 50) {
  return prisma.credentialAccessAudit.findMany({
    take: Math.min(Math.max(limit, 1), 200),
    orderBy: { timestamp: 'desc' },
  });
}

export async function listNoisyCredentials(windowMs = 60 * 60 * 1000, limit = 20) {
  const windowStart = new Date(Date.now() - Math.max(windowMs, 60_000));
  const rows = await prisma.credentialAccessAudit.groupBy({
    by: ['credentialId'],
    where: {
      timestamp: { gte: windowStart },
      OR: [{ allowed: false }, { reasonCode: 'CREDENTIAL_RATE_LIMIT_EXCEEDED' }],
    },
    _count: { _all: true },
    orderBy: { _count: { credentialId: 'desc' } },
    take: Math.min(Math.max(limit, 1), 100),
  });

  return rows.map((row) => ({ credentialId: row.credentialId, count: row._count._all }));
}

export async function listNoisyCredentialTokens(windowMs = 60 * 60 * 1000, limit = 20) {
  const windowStart = new Date(Date.now() - Math.max(windowMs, 60_000));
  const rows = await prisma.credentialAccessAudit.groupBy({
    by: ['tokenHash'],
    where: {
      tokenHash: { not: null },
      timestamp: { gte: windowStart },
      OR: [{ allowed: false }, { reasonCode: 'CREDENTIAL_RATE_LIMIT_EXCEEDED' }],
    },
    _count: { _all: true },
    orderBy: { _count: { tokenHash: 'desc' } },
    take: Math.min(Math.max(limit, 1), 100),
  });

  return rows.map((row) => ({ tokenHash: row.tokenHash, count: row._count._all }));
}
