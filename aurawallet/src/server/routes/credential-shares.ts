import { Request, Response, Router } from 'express';
import {
  createCredentialShare,
  consumeCredentialShare,
  getCredentialShare,
  getCredentialShareStatus,
  ShareAccessMode,
  ShareExpiresAfter,
} from '../lib/credential-shares';
import { getCredential, isValidCredentialId, readCredentialSecrets } from '../lib/credentials';
import { hasAnyPermission, isAdmin } from '../lib/permissions';
import { matchesScope } from '../lib/credential-scope';
import { CredentialFile } from '../types';
import { requireWalletAuth } from '../middleware/auth';
import { getErrorMessage } from '../lib/error';
import { createSecretGist, SecretGistError } from '../lib/secret-gist-share';

const router = Router();

const SHARE_EXPIRY_OPTIONS = new Set<ShareExpiresAfter>(['15m', '1h', '24h', '7d', '30d']);

class ShareRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ShareRequestError';
    this.status = status;
  }
}

function canReadCredential(req: Request, credential: CredentialFile): boolean {
  const auth = req.auth!;
  if (isAdmin(auth)) return true;
  if (!hasAnyPermission(auth.token.permissions, ['secret:read'])) return false;
  const scopes = auth.token.credentialAccess?.read || [];
  return matchesScope(credential, scopes);
}

function parseShareBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function resolveFallbackShareUrl(req: Request, shareToken: string): string {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = typeof forwardedProto === 'string'
    ? forwardedProto.split(',')[0].trim()
    : req.protocol || 'http';

  const forwardedHost = req.headers['x-forwarded-host'];
  const host = typeof forwardedHost === 'string'
    ? forwardedHost.split(',')[0].trim()
    : req.get('host');

  if (!host) return `/credential-shares/${shareToken}`;
  return `${protocol}://${host}/credential-shares/${shareToken}`;
}

function resolveShareUrl(req: Request, shareToken: string, shareBaseUrl: unknown): string {
  const base = parseShareBaseUrl(shareBaseUrl);
  if (base) {
    return `${base}/share/${shareToken}`;
  }
  return resolveFallbackShareUrl(req, shareToken);
}

function toMetaFieldValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) {
    const parts = raw
      .map((item) => {
        if (item === null || item === undefined) return '';
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return String(item);
        try {
          return JSON.stringify(item);
        } catch {
          return '';
        }
      })
      .map((value) => value.trim())
      .filter(Boolean);
    return parts.join(',');
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

function buildPlaintextGistFields(
  credential: CredentialFile,
): Array<{ key: string; value: string; sensitive?: boolean }> {
  const fields: Array<{ key: string; value: string; sensitive?: boolean }> = [];
  const seenKeys = new Set<string>();

  for (const field of readCredentialSecrets(credential.id)) {
    const key = String(field.key || '').trim();
    const value = String(field.value || '').trim();
    if (!key || !value) continue;
    const normalized = key.toLowerCase();
    if (seenKeys.has(normalized)) continue;
    seenKeys.add(normalized);
    fields.push({ key, value, sensitive: field.sensitive !== false });
  }

  for (const [key, value] of Object.entries(credential.meta || {})) {
    const normalized = key.toLowerCase();
    if (seenKeys.has(normalized)) continue;
    const serialized = toMetaFieldValue(value);
    if (!serialized || serialized.trim().length === 0) continue;
    seenKeys.add(normalized);
    fields.push({ key, value: serialized, sensitive: false });
  }

  return fields;
}

function parseShareRequest(req: Request): {
  credential: CredentialFile;
  credentialId: string;
  expiresAfter: ShareExpiresAfter;
  accessMode: ShareAccessMode;
  oneTimeOnly: boolean;
  password?: string;
  createdBy: string;
} {
  const auth = req.auth!;
  if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['secret:read'])) {
    throw new ShareRequestError(403, 'secret:read permission required');
  }

  const credentialId = typeof req.body?.credentialId === 'string' ? req.body.credentialId.trim() : '';
  if (!credentialId) {
    throw new ShareRequestError(400, 'credentialId is required');
  }
  if (!isValidCredentialId(credentialId)) {
    throw new ShareRequestError(400, 'credentialId format is invalid');
  }

  const credential = getCredential(credentialId);
  if (!credential) {
    throw new ShareRequestError(404, 'Credential not found');
  }
  if (!canReadCredential(req, credential)) {
    throw new ShareRequestError(403, 'Credential read scope denied');
  }

  const expiresAfterRaw = typeof req.body?.expiresAfter === 'string' ? req.body.expiresAfter : '24h';
  const expiresAfter = expiresAfterRaw as ShareExpiresAfter;
  if (!SHARE_EXPIRY_OPTIONS.has(expiresAfter)) {
    throw new ShareRequestError(400, 'expiresAfter must be one of: 15m, 1h, 24h, 7d, 30d');
  }

  const accessModeRaw = typeof req.body?.accessMode === 'string' ? req.body.accessMode : 'anyone';
  const accessMode = accessModeRaw as ShareAccessMode;
  if (accessMode !== 'anyone' && accessMode !== 'password') {
    throw new ShareRequestError(400, 'accessMode must be either "anyone" or "password"');
  }

  const oneTimeOnly = req.body?.oneTimeOnly === true;
  const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
  if (accessMode === 'password' && (!password || password.length === 0)) {
    throw new ShareRequestError(400, 'password is required when accessMode is "password"');
  }

  return {
    credential,
    credentialId,
    expiresAfter,
    accessMode,
    oneTimeOnly,
    password,
    createdBy: isAdmin(auth) ? 'admin' : auth.token.agentId,
  };
}

function toShareResponse(share: ReturnType<typeof createCredentialShare>) {
  return {
    token: share.token,
    credentialId: share.credentialId,
    expiresAt: share.expiresAt,
    accessMode: share.accessMode,
    oneTimeOnly: share.oneTimeOnly,
  };
}

// GET /credential-shares/:token - public share metadata
router.get('/:token', (req: Request<{ token: string }>, res: Response) => {
  const share = getCredentialShare(req.params.token);
  if (!share) {
    res.status(404).json({ success: false, error: 'Share link not found' });
    return;
  }

  const credential = getCredential(share.credentialId);
  if (!credential) {
    res.status(410).json({ success: false, error: 'Shared credential no longer exists', reason: 'credential_missing' });
    return;
  }

  const status = getCredentialShareStatus(share);
  if (status.isExpired) {
    res.status(410).json({ success: false, error: 'Share link expired', reason: 'expired' });
    return;
  }
  if (status.isAlreadyViewed) {
    res.status(410).json({ success: false, error: 'Share link already used', reason: 'already_viewed' });
    return;
  }

  res.json({
    success: true,
    share: {
      token: share.token,
      credentialId: share.credentialId,
      credentialName: credential.name,
      credentialType: credential.type,
      expiresAt: share.expiresAt,
      accessMode: share.accessMode,
      passwordRequired: share.accessMode === 'password',
      oneTimeOnly: share.oneTimeOnly,
      viewCount: share.viewCount,
      maxViews: share.oneTimeOnly ? 1 : null,
    },
  });
});

// POST /credential-shares/:token/read - public shared credential read
router.post('/:token/read', (req: Request<{ token: string }>, res: Response) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
  const result = consumeCredentialShare(req.params.token, password);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      res.status(404).json({ success: false, error: 'Share link not found', reason: 'not_found' });
      return;
    }
    if (result.reason === 'expired') {
      res.status(410).json({ success: false, error: 'Share link expired', reason: 'expired' });
      return;
    }
    if (result.reason === 'already_viewed') {
      res.status(410).json({ success: false, error: 'Share link already used', reason: 'already_viewed' });
      return;
    }
    if (result.reason === 'password_required') {
      res.status(401).json({ success: false, error: 'Share password required', reason: 'password_required' });
      return;
    }
    res.status(401).json({ success: false, error: 'Invalid share password', reason: 'invalid_password' });
    return;
  }

  const credential = getCredential(result.share.credentialId);
  if (!credential) {
    res.status(410).json({ success: false, error: 'Shared credential no longer exists', reason: 'credential_missing' });
    return;
  }

  try {
    const fields = readCredentialSecrets(credential.id);
    res.json({
      success: true,
      credential: {
        id: credential.id,
        name: credential.name,
        type: credential.type,
        meta: credential.meta,
        fields,
        createdAt: credential.createdAt,
        updatedAt: credential.updatedAt,
      },
    });
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.toLowerCase().includes('locked')) {
      res.status(423).json({ success: false, error: 'Agent is locked', reason: 'agent_locked' });
      return;
    }
    res.status(500).json({ success: false, error: message });
  }
});

router.use(requireWalletAuth);

// POST /credential-shares/gist - create share + publish secret gist
router.post('/gist', async (req: Request, res: Response) => {
  try {
    const parsed = parseShareRequest(req);
    const share = createCredentialShare({
      credentialId: parsed.credentialId,
      createdBy: parsed.createdBy,
      expiresAfter: parsed.expiresAfter,
      accessMode: parsed.accessMode,
      password: parsed.password,
      oneTimeOnly: parsed.oneTimeOnly,
    });

    const link = resolveShareUrl(req, share.token, req.body?.shareBaseUrl);
    const fields = buildPlaintextGistFields(parsed.credential);
    const gist = await createSecretGist({
      credentialId: parsed.credential.id,
      credentialName: parsed.credential.name,
      credentialType: parsed.credential.type,
      shareUrl: link,
      accessMode: share.accessMode,
      oneTimeOnly: share.oneTimeOnly,
      expiresAfter: parsed.expiresAfter,
      fields,
    });

    res.json({
      success: true,
      gist: {
        url: gist.url,
        marker: gist.marker,
        identifier: gist.identifier,
        title: gist.title,
      },
      share: toShareResponse(share),
      link,
    });
  } catch (error) {
    if (error instanceof ShareRequestError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    if (error instanceof SecretGistError) {
      res.status(400).json({
        success: false,
        error: error.message,
        code: error.code,
        remediation: error.remediation,
        detail: error.detail,
      });
      return;
    }
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

// POST /credential-shares - create a share link
router.post('/', (req: Request, res: Response) => {
  try {
    const parsed = parseShareRequest(req);
    const share = createCredentialShare({
      credentialId: parsed.credentialId,
      createdBy: parsed.createdBy,
      expiresAfter: parsed.expiresAfter,
      accessMode: parsed.accessMode,
      password: parsed.password,
      oneTimeOnly: parsed.oneTimeOnly,
    });

    res.json({
      success: true,
      share: toShareResponse(share),
    });
  } catch (error) {
    if (error instanceof ShareRequestError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

export default router;
