import { Request, Response, Router } from 'express';
import { requireWalletAuth } from '../middleware/auth';
import { requireAdmin } from '../lib/permissions';
import { getErrorMessage } from '../lib/error';
import { prisma } from '../lib/db';

const router = Router();

router.use(requireWalletAuth, requireAdmin);

function normalizeAgentIdParam(value: string): string {
  const decoded = decodeURIComponent(String(value || ''));
  const agentId = decoded.trim();
  if (!agentId) {
    throw new Error('agentId path param is required');
  }
  return agentId;
}

// ---------------------------------------------------------------------------
// Input normalization (moved from shared/agent-profile-schema.ts)
// ---------------------------------------------------------------------------

function readOptionalString(input: Record<string, unknown>, key: string, aliases: string[] = []): string | undefined {
  const candidates = [key, ...aliases];
  for (const candidate of candidates) {
    const value = input[candidate];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new Error(`agent profile field "${key}" must be a string`);
    }
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed;
  }
  return undefined;
}

function readAttributes(input: Record<string, unknown>): Record<string, string> | undefined {
  const raw = input.attributes ?? input.custom_attributes ?? input.customAttributes;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('agent profile field "attributes" must be an object');
  }

  const attributes: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) {
      throw new Error('agent profile attribute keys must be non-empty');
    }
    if (typeof rawValue !== 'string') {
      throw new Error(`agent profile attribute "${key}" must be a string`);
    }
    attributes[key] = rawValue;
  }

  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

interface NormalizedProfileInput {
  agentId: string;
  email?: string;
  phone?: string;
  address?: string;
  profileImage?: string;
  attributes?: Record<string, string>;
}

function normalizeAgentProfileInput(
  value: unknown,
  options: { fallbackAgentId?: string } = {},
): NormalizedProfileInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent profile payload must be an object');
  }
  const input = value as Record<string, unknown>;

  const rawAgentId = input.agentId ?? input.agent_id ?? options.fallbackAgentId;
  if (typeof rawAgentId !== 'string' || rawAgentId.trim().length === 0) {
    throw new Error('agent profile requires non-empty agentId');
  }
  const agentId = rawAgentId.trim();

  const email = readOptionalString(input, 'email');
  const phone = readOptionalString(input, 'phone');
  const address = readOptionalString(input, 'address');
  const profileImage = readOptionalString(input, 'profileImage', ['profile_image']);
  const attributes = readAttributes(input);

  return {
    agentId,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
    ...(profileImage ? { profileImage } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Prisma row → API response shape
// ---------------------------------------------------------------------------

interface ProfileRow {
  agentId: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  profileImage: string | null;
  attributes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toApiProfile(row: ProfileRow) {
  return {
    agentId: row.agentId,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    address: row.address ?? undefined,
    profileImage: row.profileImage ?? undefined,
    attributes: row.attributes ? JSON.parse(row.attributes) : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.agentProfile.findMany({ orderBy: { agentId: 'asc' } });
    const profiles = rows.map(toApiProfile);
    res.json({ success: true, profiles });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

router.get('/:agentId', async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const agentId = normalizeAgentIdParam(req.params.agentId);
    const row = await prisma.agentProfile.findUnique({ where: { agentId } });
    if (!row) {
      res.status(404).json({ success: false, error: 'Agent profile not found' });
      return;
    }
    res.json({ success: true, profile: toApiProfile(row) });
  } catch (error) {
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

router.put('/:agentId', async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const agentId = normalizeAgentIdParam(req.params.agentId);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const bodyAgentIdRaw = body.agentId ?? body.agent_id;
    if (typeof bodyAgentIdRaw === 'string' && bodyAgentIdRaw.trim() && bodyAgentIdRaw.trim() !== agentId) {
      res.status(400).json({ success: false, error: 'body agentId must match path param' });
      return;
    }
    const normalized = normalizeAgentProfileInput(body, { fallbackAgentId: agentId });
    const row = await prisma.agentProfile.upsert({
      where: { agentId },
      create: {
        agentId,
        email: normalized.email ?? null,
        phone: normalized.phone ?? null,
        address: normalized.address ?? null,
        profileImage: normalized.profileImage ?? null,
        attributes: normalized.attributes ? JSON.stringify(normalized.attributes) : null,
      },
      update: {
        email: normalized.email ?? null,
        phone: normalized.phone ?? null,
        address: normalized.address ?? null,
        profileImage: normalized.profileImage ?? null,
        attributes: normalized.attributes ? JSON.stringify(normalized.attributes) : null,
      },
    });
    res.json({ success: true, profile: toApiProfile(row) });
  } catch (error) {
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

router.delete('/:agentId', async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const agentId = normalizeAgentIdParam(req.params.agentId);
    const existing = await prisma.agentProfile.findUnique({ where: { agentId } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Agent profile not found' });
      return;
    }
    await prisma.agentProfile.delete({ where: { agentId } });
    res.json({ success: true, deleted: true, agentId });
  } catch (error) {
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

export default router;
