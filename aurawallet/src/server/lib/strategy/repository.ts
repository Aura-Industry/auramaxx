import { prisma } from '../db';
import type { StrategyManifest } from './types';

export interface PersistedStrategy {
  id: string;
  name: string;
  templateId: string | null;
  mode: string;
  manifest: StrategyManifest;
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  schedule: Record<string, unknown>;
  permissions: string[];
  limits: { fund?: number; send?: number } | null;
  enabled: boolean;
  status: string;
  createdBy: string;
  provenance: Record<string, unknown> | null;
  appId: string | null;
  lastTickAt: Date | null;
  lastError: string | null;
  errorCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface CreatePersistedStrategyInput {
  id: string;
  name: string;
  templateId?: string | null;
  mode?: string;
  manifest: StrategyManifest;
  config?: Record<string, unknown>;
  state?: Record<string, unknown>;
  schedule?: Record<string, unknown>;
  permissions?: string[];
  limits?: { fund?: number; send?: number } | null;
  enabled?: boolean;
  status?: string;
  createdBy?: string;
  provenance?: Record<string, unknown> | null;
  appId?: string | null;
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function parseArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseLimits(value: string | null | undefined): { fund?: number; send?: number } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { fund?: unknown; send?: unknown };
    const next: { fund?: number; send?: number } = {};
    if (typeof parsed.fund === 'number') next.fund = parsed.fund;
    if (typeof parsed.send === 'number') next.send = parsed.send;
    return Object.keys(next).length > 0 ? next : null;
  } catch {
    return null;
  }
}

function deserializeStrategy(row: {
  id: string;
  name: string;
  templateId: string | null;
  mode: string;
  manifest: string;
  config: string | null;
  state: string | null;
  schedule: string | null;
  permissions: string;
  limits: string | null;
  enabled: boolean;
  status: string;
  createdBy: string;
  provenance: string | null;
  appId: string | null;
  lastTickAt: Date | null;
  lastError: string | null;
  errorCount: number;
  createdAt: Date;
  updatedAt: Date;
}): PersistedStrategy {
  const manifestParsed = parseObject(row.manifest) as unknown as StrategyManifest;
  return {
    id: row.id,
    name: row.name,
    templateId: row.templateId,
    mode: row.mode,
    manifest: manifestParsed,
    config: parseObject(row.config),
    state: parseObject(row.state),
    schedule: parseObject(row.schedule),
    permissions: parseArray(row.permissions),
    limits: parseLimits(row.limits),
    enabled: row.enabled,
    status: row.status,
    createdBy: row.createdBy,
    provenance: row.provenance ? parseObject(row.provenance) : null,
    appId: row.appId,
    lastTickAt: row.lastTickAt,
    lastError: row.lastError,
    errorCount: row.errorCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listPersistedStrategies(): Promise<PersistedStrategy[]> {
  const rows = await prisma.strategy.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(deserializeStrategy).filter((strategy) => {
    const m = strategy.manifest as unknown as Record<string, unknown>;
    if (!m.id || typeof m.id !== 'string' ||
        !m.name || typeof m.name !== 'string' ||
        !m.hooks || typeof m.hooks !== 'object') {
      console.warn(`[strategy:${strategy.id}] skipping — invalid manifest (missing id, name, or hooks)`);
      return false;
    }
    return true;
  });
}

export async function getPersistedStrategy(id: string): Promise<PersistedStrategy | null> {
  const row = await prisma.strategy.findUnique({
    where: { id },
  });
  return row ? deserializeStrategy(row) : null;
}

export async function createPersistedStrategy(input: CreatePersistedStrategyInput): Promise<PersistedStrategy> {
  const row = await prisma.strategy.create({
    data: {
      id: input.id,
      name: input.name,
      templateId: input.templateId ?? null,
      mode: input.mode ?? 'headless',
      manifest: JSON.stringify(input.manifest),
      config: JSON.stringify(input.config ?? {}),
      state: JSON.stringify(input.state ?? {}),
      schedule: JSON.stringify(input.schedule ?? {}),
      permissions: JSON.stringify(input.permissions ?? []),
      limits: input.limits ? JSON.stringify(input.limits) : null,
      enabled: input.enabled ?? false,
      status: input.status ?? 'draft',
      createdBy: input.createdBy ?? 'human',
      provenance: input.provenance ? JSON.stringify(input.provenance) : null,
      appId: input.appId ?? null,
    },
  });
  return deserializeStrategy(row);
}

export async function updatePersistedStrategyEnabled(id: string, enabled: boolean): Promise<PersistedStrategy | null> {
  try {
    const row = await prisma.strategy.update({
      where: { id },
      data: {
        enabled,
        status: enabled ? 'enabled' : 'disabled',
        lastError: null,
      },
    });
    return deserializeStrategy(row);
  } catch {
    return null;
  }
}

export async function updatePersistedStrategyConfig(
  id: string,
  config: Record<string, unknown>,
): Promise<PersistedStrategy | null> {
  try {
    const row = await prisma.strategy.update({
      where: { id },
      data: { config: JSON.stringify(config) },
    });
    return deserializeStrategy(row);
  } catch {
    return null;
  }
}

export async function updatePersistedStrategyState(
  id: string,
  state: Record<string, unknown>,
): Promise<PersistedStrategy | null> {
  try {
    const row = await prisma.strategy.update({
      where: { id },
      data: { state: JSON.stringify(state) },
    });
    return deserializeStrategy(row);
  } catch {
    return null;
  }
}
