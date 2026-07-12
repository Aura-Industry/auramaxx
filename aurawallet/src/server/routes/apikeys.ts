import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db';
import { requireWalletAuth } from '../middleware/auth';
import { requirePermissionForRoute } from '../lib/permissions';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';
import {
  APIKEY_DB_PLACEHOLDER,
  deleteApiKeyCredentialById,
  deleteApiKeyCredentialByServiceName,
  listApiKeyCredentials,
  maskKey,
  migrateApiKeysFromDatabase,
  upsertApiKeyCredential,
} from '../lib/apikey-migration';
import { isUnlocked } from '../lib/cold';
import { logger } from '../lib/logger';
import { getErrorMessage } from '../lib/error';

const router = Router();

async function listLegacyApiKeysFromDb() {
  const apiKeys = await prisma.apiKey.findMany({
    where: { isActive: true },
    select: {
      id: true,
      service: true,
      name: true,
      key: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ service: 'asc' }, { name: 'asc' }],
  });

  return apiKeys.map(row => ({
    id: row.id,
    service: row.service,
    name: row.name,
    keyMasked: maskKey(row.key),
    metadata: row.metadata ? (() => {
      try {
        return JSON.parse(row.metadata!);
      } catch {
        return row.metadata;
      }
    })() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

// GET /apikeys - List all API keys
// Requires: apikey:get permission
router.get('/', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APIKEY_GET, 'apikey:get'), async (_req: Request, res: Response) => {
  try {
    await migrateApiKeysFromDatabase();
    const credentials = listApiKeyCredentials()
      .sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
    const apiKeys = credentials.length > 0 ? credentials : await listLegacyApiKeysFromDb();

    res.json({
      success: true,
      apiKeys,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// POST /apikeys/validate - Validate an API key against external service
// Requires: apikey:set permission
router.post('/validate', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APIKEY_SET, 'apikey:set'), async (req: Request, res: Response) => {
  try {
    const { service, key } = req.body;

    if (!service || typeof service !== 'string') {
      res.status(400).json({ error: 'service is required' });
      return;
    }

    if (!key || typeof key !== 'string') {
      res.status(400).json({ error: 'key is required' });
      return;
    }

    // 5s timeout for external validation
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      switch (service) {
        case 'alchemy': {
          const resp = await fetch(`https://base-mainnet.g.alchemy.com/v2/${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
            signal: controller.signal,
          });
          const data = await resp.json() as { jsonrpc?: string; result?: string; error?: { message?: string } };
          if (data.jsonrpc === '2.0' && data.result) {
            res.json({ valid: true });
          } else {
            res.json({ valid: false, error: data.error?.message || 'Invalid response from Alchemy' });
          }
          break;
        }

        case 'anthropic': {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
            signal: controller.signal,
          });
          if (resp.status === 200 || resp.status === 429) {
            // 200 = valid, 429 = rate limited but key is valid
            res.json({ valid: true });
          } else if (resp.status === 401) {
            res.json({ valid: false, error: 'Invalid API key' });
          } else {
            res.json({ valid: false, error: `Unexpected status: ${resp.status}` });
          }
          break;
        }

        case 'openai': {
          const resp = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': `Bearer ${key}` },
            signal: controller.signal,
          });
          if (resp.status === 200) {
            res.json({ valid: true });
          } else if (resp.status === 401) {
            res.json({ valid: false, error: 'Invalid API key' });
          } else {
            res.json({ valid: false, error: `Unexpected status: ${resp.status}` });
          }
          break;
        }

        case 'adapter:telegram': {
          const resp = await fetch(`https://api.telegram.org/bot${key}/getMe`, {
            signal: controller.signal,
          });
          const data = await resp.json() as { ok?: boolean; result?: { username?: string } };
          if (data.ok && data.result) {
            res.json({ valid: true, info: { botUsername: data.result.username } });
          } else {
            res.json({ valid: false, error: 'Invalid bot token' });
          }
          break;
        }

        default:
          res.status(400).json({ error: `Unknown service: ${service}` });
          return;
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        res.json({ valid: false, error: 'Validation timed out' });
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// POST /apikeys - Create or update an API key
// Requires: apikey:set permission
router.post('/', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APIKEY_SET, 'apikey:set'), async (req: Request, res: Response) => {
  try {
    const { service, name, key, metadata } = req.body;

    if (!service || typeof service !== 'string') {
      res.status(400).json({ error: 'service is required' });
      return;
    }

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    if (!key || typeof key !== 'string') {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    if (!isUnlocked()) {
      res.status(401).json({ error: 'Wallet is locked. Unlock first.' });
      return;
    }

    const parsedMetadata = metadata === undefined ? null : metadata;

    const apiKey = upsertApiKeyCredential(service, name, key, parsedMetadata);

    // Keep a non-secret legacy DB row for metadata/indexing only.
    await prisma.apiKey.upsert({
      where: {
        service_name: { service, name }
      },
      update: {
        key: APIKEY_DB_PLACEHOLDER,
        metadata: parsedMetadata ? JSON.stringify(parsedMetadata) : null,
        isActive: true,
        updatedAt: new Date()
      },
      create: {
        service,
        name,
        key: APIKEY_DB_PLACEHOLDER,
        metadata: parsedMetadata ? JSON.stringify(parsedMetadata) : null
      }
    });

    logger.apiKeyCreated(service, name);

    res.json({
      success: true,
      apiKey: {
        ...apiKey,
        key: apiKey.keyMasked,
      },
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// DELETE /apikeys/revoke-all - Revoke all API keys
// Requires: apikey:set permission
router.delete('/revoke-all', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APIKEY_SET, 'apikey:set'), async (_req: Request, res: Response) => {
  try {
    await migrateApiKeysFromDatabase();

    const credentials = listApiKeyCredentials();
    let revokedCount = 0;

    for (const credential of credentials) {
      const deleted = deleteApiKeyCredentialById(credential.id);
      if (!deleted) continue;

      await prisma.apiKey.updateMany({
        where: {
          service: deleted.service,
          name: deleted.name,
          isActive: true,
        },
        data: { isActive: false },
      });
      revokedCount++;
    }

    // Legacy fallback in case credentials were not yet migrated.
    if (revokedCount === 0) {
      const result = await prisma.apiKey.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      });
      revokedCount = result.count;
    }

    logger.apiKeysRevokedAll(revokedCount);

    res.json({
      success: true,
      revokedCount,
      message: revokedCount > 0
        ? `Revoked ${revokedCount} API key${revokedCount === 1 ? '' : 's'}`
        : 'No active API keys to revoke',
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// DELETE /apikeys/:id - Delete an API key
// Requires: apikey:set permission
router.delete('/:id', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APIKEY_SET, 'apikey:set'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    await migrateApiKeysFromDatabase();

    // New path: id is a credential file id.
    const deletedCredential = deleteApiKeyCredentialById(id);
    if (deletedCredential) {
      await prisma.apiKey.updateMany({
        where: {
          service: deletedCredential.service,
          name: deletedCredential.name,
          isActive: true,
        },
        data: { isActive: false },
      });
      logger.apiKeyDeleted(deletedCredential.service, deletedCredential.name);
      res.json({
        success: true,
        message: `API key '${deletedCredential.name}' for ${deletedCredential.service} has been deleted`,
      });
      return;
    }

    // Legacy fallback path: id is from ApiKey table.
    const apiKey = await prisma.apiKey.findUnique({ where: { id } });
    if (!apiKey) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    await prisma.apiKey.update({
      where: { id },
      data: { isActive: false }
    });
    deleteApiKeyCredentialByServiceName(apiKey.service, apiKey.name);

    logger.apiKeyDeleted(apiKey.service, apiKey.name);

    res.json({
      success: true,
      message: `API key '${apiKey.name}' for ${apiKey.service} has been deleted`
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

export default router;
