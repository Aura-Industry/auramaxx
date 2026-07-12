import { Router, Request, Response } from 'express';
import type { Prisma, HumanAction, SyncState } from '@prisma/client';
import { prisma } from '../lib/db';
import {
  createCredential,
  listCredentials,
  readCredentialSecrets,
  updateCredential,
} from '../lib/credentials';
import { listAgents } from '../lib/cold';
import {
  appendDiaryEntry,
  DIARY_ENTRY_COUNT_KEY,
  formatDiaryEntry,
  getDiaryCredentialName,
  getLegacyDiaryCredentialName,
  resolveDiaryEntryCount,
  resolveDiaryDate,
} from '../lib/diary';
import { listTokensFromDb } from '../lib/sessions';
import { getErrorMessage } from '../lib/error';
import { requireWalletAuth } from '../middleware/auth';
import { hasAnyPermission } from '../lib/permissions';
import { redactJsonString, redactSensitiveData } from '../lib/redaction';
import {
  getCredentialFieldValue,
  normalizeCredentialFieldsForType,
  NOTE_CONTENT_KEY,
} from '../../../shared/credential-field-schema';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

const router = Router();

type ParsedEventData = Record<string, unknown> | string;
type HeartbeatEvent = {
  type: string;
  timestamp: string;
  data: ParsedEventData;
};

type SecretAccessDetail = {
  name: string;
  agentId: string;
  action: string;
  timestamp: string;
};

function parseSince(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseEventData(data: string): ParsedEventData {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return redactSensitiveData(parsed) as Record<string, unknown>;
    }
    return redactJsonString(data);
  } catch {
    return redactJsonString(data);
  }
}

/**
 * Resolve the agent for diary entries — uses primary agent by default.
 */
function resolveDiaryAgentId(explicitAgentId: unknown): string {
  if (typeof explicitAgentId === 'string' && explicitAgentId.trim()) {
    return explicitAgentId.trim();
  }

  try {
    const agents = listAgents();
    const primaryAgent = agents.find((agent) => agent.isPrimary || agent.id === 'primary');
    if (primaryAgent) return primaryAgent.id;
    return 'primary';
  } catch {
    return 'primary';
  }
}

function mergeDiaryTags(meta: Record<string, unknown>): string[] {
  const existing = Array.isArray(meta.tags)
    ? meta.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const merged = new Set([...existing, 'diary', 'heartbeat']);
  return [...merged];
}

function formatUtcTime(timestampIso: string): string {
  const date = new Date(timestampIso);
  return date.toISOString().slice(11, 16);
}

function pluralize(word: string, count: number): string {
  return `${word}${count === 1 ? '' : 's'}`;
}

function getCredentialLabel(data: Record<string, unknown>): string | null {
  const credentialName = typeof data.credentialName === 'string' ? data.credentialName.trim() : '';
  if (credentialName) return credentialName;
  const credentialId = typeof data.credentialId === 'string' ? data.credentialId.trim() : '';
  if (credentialId) return credentialId;
  return null;
}

function buildHumanActionHighlights(actions: HumanAction[]): string[] {
  const highlights: string[] = [];
  const pending = actions.filter((action) => action.status === 'pending');
  const approved = actions.filter((action) => action.status === 'approved');
  const rejected = actions.filter((action) => action.status === 'rejected');

  highlights.push(
    `${pending.length} pending ${pluralize('request', pending.length)} waiting`,
    `${approved.length} approved ${pluralize('request', approved.length)} recently`,
    `${rejected.length} rejected ${pluralize('request', rejected.length)} recently`,
  );

  const latestApproved = approved[0];
  if (latestApproved) {
    highlights.push(
      `Human approved ${latestApproved.type} request #${latestApproved.id.slice(0, 8)}`,
    );
  }

  const latestRejected = rejected[0];
  if (latestRejected) {
    highlights.push(
      `Human rejected ${latestRejected.type} request #${latestRejected.id.slice(0, 8)}`,
    );
  }

  return highlights;
}

function buildSyncHighlights(syncRows: SyncState[]): string[] {
  const highlights: string[] = [];
  for (const row of syncRows) {
    if (row.lastError) {
      highlights.push(`Sync issue on ${row.chain}: ${row.lastError}`);
      continue;
    }
    if (row.lastSyncStatus !== 'ok' && row.lastSyncStatus !== 'idle') {
      highlights.push(`Sync status on ${row.chain}: ${row.lastSyncStatus}`);
    }
  }
  return highlights;
}

function buildCredentialEventHighlights(events: HeartbeatEvent[]): string[] {
  const highlights: string[] = [];

  for (const event of events) {
    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
      continue;
    }
    const data = event.data as Record<string, unknown>;

    if (event.type === 'secret:accessed') {
      const agentId = typeof data.agentId === 'string' ? data.agentId : 'agent';
      const credName = getCredentialLabel(data) ?? 'secret';
      const surface = typeof data.surface === 'string' ? data.surface : 'unknown';
      const envVar = typeof data.envVar === 'string' ? ` into ${data.envVar}` : '';
      const verb = surface === 'inject_secret' ? `injected "${credName}"${envVar}` : `read secret "${credName}"`;
      highlights.push(
        `Agent ${agentId} ${verb} at ${formatUtcTime(event.timestamp)} UTC`,
      );
    }

    if (event.type === 'credential:accessed' && data.allowed === true) {
      const agentId = typeof data.agentId === 'string' ? data.agentId : 'agent';
      const credentialName = getCredentialLabel(data) ?? 'credential';
      highlights.push(
        `Agent ${agentId} read credential "${credentialName}" at ${formatUtcTime(event.timestamp)} UTC`,
      );
    }

    if (event.type === 'credential:changed') {
      const credentialName = getCredentialLabel(data) ?? 'credential';
      const change = typeof data.change === 'string' ? data.change.replaceAll('_', ' ') : 'updated';
      highlights.push(`Credential "${credentialName}" was ${change}`);
    }

    if (highlights.length >= 6) break;
  }

  return highlights;
}

function buildAuthorizationSummary(actions: HumanAction[]) {
  const pending = actions.filter((action) => action.status === 'pending').length;
  const approved = actions.filter((action) => action.status === 'approved').length;
  const rejected = actions.filter((action) => action.status === 'rejected').length;
  return {
    total: actions.length,
    pending,
    approved,
    rejected,
  };
}

function buildSecretAccessSummary(events: HeartbeatEvent[]) {
  const details: SecretAccessDetail[] = [];

  for (const event of events) {
    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
      continue;
    }
    const data = event.data as Record<string, unknown>;
    const agentId = typeof data.agentId === 'string' && data.agentId.trim() ? data.agentId : 'agent';
    const name = getCredentialLabel(data) ?? 'secret';

    if (event.type === 'secret:accessed') {
      const surface = typeof data.surface === 'string' ? data.surface : 'unknown';
      details.push({
        name,
        agentId,
        action: surface === 'inject_secret' ? 'injected' : 'read',
        timestamp: event.timestamp,
      });
      continue;
    }

    if (event.type === 'credential:accessed' && data.allowed === true) {
      details.push({
        name,
        agentId,
        action: 'read',
        timestamp: event.timestamp,
      });
      continue;
    }

    if (event.type === 'credential:changed') {
      const change = typeof data.change === 'string' && data.change.trim()
        ? data.change.replaceAll('_', ' ')
        : 'updated';
      details.push({
        name,
        agentId,
        action: change,
        timestamp: event.timestamp,
      });
    }
  }

  const nameCounts = new Map<string, number>();
  const agentCounts = new Map<string, number>();
  for (const detail of details) {
    nameCounts.set(detail.name, (nameCounts.get(detail.name) ?? 0) + 1);
    agentCounts.set(detail.agentId, (agentCounts.get(detail.agentId) ?? 0) + 1);
  }

  return {
    count: details.length,
    names: [...nameCounts.keys()].slice(0, 8),
    topNames: [...nameCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
    byAgent: [...agentCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([agentId, count]) => ({ agentId, count })),
    details: details.slice(0, 8),
  };
}

function buildDiaryHint(summary: {
  authorizations: { pending: number; approved: number; rejected: number };
  secrets: { count: number; names: string[] };
}): string {
  const authPart = `${summary.authorizations.pending} pending / ${summary.authorizations.approved} approved / ${summary.authorizations.rejected} rejected authorizations`;
  if (summary.secrets.count === 0) {
    return `${authPart}; no secret access recorded in this window.`;
  }
  const names = summary.secrets.names.slice(0, 3);
  const moreCount = Math.max(summary.secrets.names.length - names.length, 0);
  const namesPart = names.length > 0 ? names.join(', ') : 'secret activity';
  const morePart = moreCount > 0 ? ` +${moreCount} more` : '';
  return `${authPart}; ${summary.secrets.count} secret access events (${namesPart}${morePart}).`;
}

function buildHeartbeatEndpoints() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    heartbeat: {
      method: 'GET',
      path: '/what_is_happening',
      auth: 'none',
      query: ['since', 'agentId', 'limit'],
    },
    diaryWrite: {
      method: 'POST',
      path: '/what_is_happening/diary',
      auth: 'Bearer token with secret:write or admin:*',
      body: {
        entry: 'string (required)',
        date: 'YYYY-MM-DD (optional, UTC today default)',
        agentId: 'string (optional, defaults to primary agent)',
      },
      noteNamePattern: '{YYYY-MM-DD}_LOGS',
      todayExample: `${today}_LOGS`,
    },
  };
}

// POST /what_is_happening/diary - non-MCP diary writer for HTTP agents
router.post('/diary', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    if (!req.auth || !hasAnyPermission(req.auth.token.permissions, ['secret:write'])) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.HEARTBEAT_SECRET_WRITE,
        error: 'secret:write permission required',
        required: ['secret:write'],
        have: req.auth?.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    const entry = typeof req.body?.entry === 'string' ? req.body.entry.trim() : '';
    if (!entry) {
      res.status(400).json({ success: false, error: 'entry is required' });
      return;
    }

    const date = typeof req.body?.date === 'string' ? req.body.date : undefined;
    const resolvedDate = resolveDiaryDate(date);
    if (!resolvedDate) {
      res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
      return;
    }

    const agentId = resolveDiaryAgentId(req.body?.agentId);
    const diaryName = getDiaryCredentialName(resolvedDate);
    const legacyDiaryName = getLegacyDiaryCredentialName(resolvedDate);
    const entryBlock = formatDiaryEntry(entry);

    const candidates = listCredentials({ agentId, type: 'plain_note', query: resolvedDate });
    const existing = candidates.find((credential) => credential.name === diaryName)
      || candidates.find((credential) => credential.name === legacyDiaryName);

    if (!existing) {
      const createdMeta: Record<string, unknown> = {
        tags: ['diary', 'heartbeat'],
        [DIARY_ENTRY_COUNT_KEY]: 1,
        [NOTE_CONTENT_KEY]: entryBlock,
      };
      const created = createCredential(
        agentId,
        'plain_note',
        diaryName,
        createdMeta,
        [],
      );

      res.json({
        success: true,
        date: resolvedDate,
        name: diaryName,
        entryCount: 1,
        credentialId: created.id,
        agentId,
      });
      return;
    }

    const secrets = normalizeCredentialFieldsForType('plain_note', readCredentialSecrets(existing.id));
    const existingMeta = existing.meta && typeof existing.meta === 'object' && !Array.isArray(existing.meta)
      ? existing.meta as Record<string, unknown>
      : {};
    const metaContent = typeof existingMeta[NOTE_CONTENT_KEY] === 'string' ? existingMeta[NOTE_CONTENT_KEY] : '';
    const secretContent = getCredentialFieldValue('plain_note', secrets, NOTE_CONTENT_KEY) || '';
    const currentText = metaContent.trim() ? metaContent : secretContent;
    const nextText = appendDiaryEntry(currentText, entryBlock);
    const previousEntryCount = resolveDiaryEntryCount(existingMeta, currentText);
    const nextEntryCount = previousEntryCount + 1;

    const updated = updateCredential(existing.id, {
      name: diaryName,
      meta: {
        ...existingMeta,
        [NOTE_CONTENT_KEY]: nextText,
        [DIARY_ENTRY_COUNT_KEY]: nextEntryCount,
        tags: mergeDiaryTags(existingMeta),
      },
      // plain_note content is stored in metadata (non-sensitive)
      sensitiveFields: [],
    });

    res.json({
      success: true,
      date: resolvedDate,
      name: updated.name,
      entryCount: nextEntryCount,
      credentialId: updated.id,
      agentId: updated.agentId,
    });
  } catch (error) {
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

// GET /what_is_happening - consolidated, no-auth status endpoint for heartbeat checks
router.get('/', async (req: Request, res: Response) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    const sinceQuery = req.query.since;
    const since = sinceQuery !== undefined ? parseSince(sinceQuery) : null;
    if (sinceQuery !== undefined && !since) {
      res.status(400).json({ success: false, error: 'Invalid since timestamp' });
      return;
    }

    const requestedLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const eventLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 50)
      : 20;

    const humanWhere: Prisma.HumanActionWhereInput = {
      NOT: { type: 'strategy:message' },
      ...(agentId ? { metadata: { contains: `"agentId":"${agentId}"` } } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    };

    const eventWhere: Prisma.EventWhereInput = {
      ...(agentId ? { data: { contains: `"agentId":"${agentId}"` } } : {}),
      ...(since ? { timestamp: { gte: since } } : {}),
    };

    const [humanActions, allTokens, eventsRaw, syncRows] = await Promise.all([
      prisma.humanAction.findMany({
        where: humanWhere,
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      listTokensFromDb(),
      prisma.event.findMany({
        where: eventWhere,
        orderBy: { timestamp: 'desc' },
        take: eventLimit,
      }),
      prisma.syncState.findMany({
        orderBy: { chain: 'asc' },
      }),
    ]);

    const activeTokens = allTokens
      .filter((token) => token.agentId !== 'admin' && token.isActive)
      .filter((token) => !since || token.createdAt >= since.getTime());

    const recentEvents: HeartbeatEvent[] = eventsRaw.map((event) => ({
      id: event.id,
      type: event.type,
      source: event.source,
      timestamp: event.timestamp.toISOString(),
      data: parseEventData(event.data),
    }));
    const safeHumanActions = humanActions.map((action) => ({
      ...action,
      metadata: typeof action.metadata === 'string' ? redactJsonString(action.metadata) : action.metadata,
    }));

    const syncHealth = Object.fromEntries(
      syncRows.map((row) => [row.chain, {
        status: row.lastSyncStatus,
        lastSync: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        lastBlock: row.lastBlock,
        lastError: row.lastError,
      }]),
    );

    const highlights = [
      ...buildHumanActionHighlights(humanActions),
      ...buildSyncHighlights(syncRows),
      ...buildCredentialEventHighlights(recentEvents),
    ].slice(0, 12);

    const summary = {
      authorizations: buildAuthorizationSummary(humanActions),
      secrets: buildSecretAccessSummary(recentEvents),
    };
    const diaryHint = buildDiaryHint(summary);

    res.json({
      success: true,
      humanActions: safeHumanActions,
      activeTokens,
      recentEvents,
      syncHealth,
      highlights,
      summary: {
        ...summary,
        diaryHint,
      },
      endpoints: buildHeartbeatEndpoints(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

export default router;
