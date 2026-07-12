/**
 * OAuth2 Refresh Token Logic
 * ==========================
 *
 * Handles transparent access_token refresh for oauth2 credential type.
 * Called during credential read path — if access_token is expired,
 * refreshes via token_endpoint and updates stored credential.
 */

import { CredentialFile, CredentialField } from '../types';
import { getCredential, readCredentialSecrets, updateCredential } from './credentials';

/** Buffer in seconds before expiry to trigger refresh */
const EXPIRY_BUFFER_SECONDS = 60;

/** Minimum seconds between refreshes for the same credential */
const REFRESH_COOLDOWN_SECONDS = 5;

/** Track last refresh time per credential for rate limiting */
const lastRefreshTime = new Map<string, number>();

export interface OAuth2RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
}

/**
 * Check if an oauth2 credential's access_token is expired or nearly expired.
 */
export function isTokenExpired(credential: CredentialFile): boolean {
  const rawExpiresAt = credential.meta.expires_at as number | string | null | undefined;
  const expiresAt =
    typeof rawExpiresAt === 'string' ? Number(rawExpiresAt) : rawExpiresAt;

  if (!Number.isFinite(expiresAt) || expiresAt == null) return true; // Missing/invalid expiry info → assume expired
  if (expiresAt <= 0) return true;

  const now = Math.floor(Date.now() / 1000);
  return now >= expiresAt - EXPIRY_BUFFER_SECONDS;
}

/**
 * Check if refresh is rate-limited for this credential.
 */
export function isRefreshRateLimited(credentialId: string): boolean {
  const last = lastRefreshTime.get(credentialId);
  if (!last) return false;
  return (Date.now() - last) < REFRESH_COOLDOWN_SECONDS * 1000;
}

/**
 * Perform OAuth2 token refresh against the token_endpoint.
 */
export async function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  authMethod: string = 'client_secret_post',
): Promise<OAuth2RefreshResult> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (authMethod === 'client_secret_basic') {
    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  } else {
    // client_secret_post (default)
    params.set('client_id', clientId);
    params.set('client_secret', clientSecret);
  }

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    const status = response.status;
    const loweredBody = body.toLowerCase();
    const parsed = (() => {
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        return null;
      }
    })();
    const hasInvalidGrant =
      status === 400 &&
      (loweredBody.includes('invalid_grant') ||
       (typeof parsed?.error === 'string' && parsed.error.toLowerCase() === 'invalid_grant'));

    // 401 or 400 with invalid_grant means refresh token is revoked
    if (status === 401 || hasInvalidGrant) {
      const err = new Error(`OAuth2 refresh token revoked (${status}): ${body}`);
      (err as any).revoked = true;
      (err as any).statusCode = status;
      throw err;
    }
    throw new Error(`OAuth2 refresh failed (${status}): ${body}`);
  }

  const data = await response.json() as Record<string, unknown>;

  if (typeof data.access_token !== 'string') {
    throw new Error('OAuth2 refresh response missing access_token');
  }

  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
    tokenType: typeof data.token_type === 'string' ? data.token_type : undefined,
  };
}

/**
 * Attempt a fetch-based refresh with one retry on transient network errors.
 */
async function refreshWithRetry(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  authMethod: string,
): Promise<OAuth2RefreshResult> {
  try {
    return await refreshAccessToken(tokenEndpoint, refreshToken, clientId, clientSecret, authMethod);
  } catch (err: any) {
    // Don't retry on revoked tokens or HTTP errors — only network failures
    if (err.revoked) throw err;
    if (err.message?.startsWith('OAuth2 refresh failed')) throw err;
    if (err.message?.startsWith('OAuth2 refresh response')) throw err;
    // Transient network error — retry once
    return await refreshAccessToken(tokenEndpoint, refreshToken, clientId, clientSecret, authMethod);
  }
}

/**
 * Read oauth2 credential secrets, auto-refreshing if expired.
 * Returns the (possibly refreshed) sensitive fields.
 */
export async function readOAuth2SecretsWithRefresh(
  credentialId: string,
): Promise<CredentialField[]> {
  const credential = getCredential(credentialId);
  if (!credential) throw new Error(`Credential not found: ${credentialId}`);
  if (credential.type !== 'oauth2') throw new Error('Not an oauth2 credential');

  let fields = readCredentialSecrets(credentialId);

  if (isTokenExpired(credential)) {
    // Rate limit check
    if (isRefreshRateLimited(credentialId)) {
      // Return current fields without refreshing
      return fields;
    }

    const fieldMap = new Map(fields.map(f => [f.key, f.value]));
    const refreshToken = fieldMap.get('refresh_token');
    const clientId = fieldMap.get('client_id');
    const clientSecret = fieldMap.get('client_secret');
    const tokenEndpoint = credential.meta.token_endpoint as string;
    const authMethod = (credential.meta.auth_method as string) || 'client_secret_post';

    if (!refreshToken || !clientId || !clientSecret || !tokenEndpoint) {
      throw new Error('OAuth2 credential missing required fields for refresh');
    }

    try {
      const result = await refreshWithRetry(
        tokenEndpoint,
        refreshToken,
        clientId,
        clientSecret,
        authMethod,
      );

      // Record refresh time for rate limiting
      lastRefreshTime.set(credentialId, Date.now());

      // Update fields with new tokens
      const updatedFields = fields.map(f => {
        if (f.key === 'access_token') return { ...f, value: result.accessToken };
        if (f.key === 'refresh_token' && result.refreshToken) return { ...f, value: result.refreshToken };
        return f;
      });

      // Update expires_at and last_refreshed in meta
      const newExpiresAt = result.expiresIn
        ? Math.floor(Date.now() / 1000) + result.expiresIn
        : null;

      updateCredential(credentialId, {
        meta: {
          ...credential.meta,
          needs_reauth: false,
          reauth_reason: null,
          expires_at: newExpiresAt,
          last_refreshed: new Date().toISOString(),
        },
        sensitiveFields: updatedFields,
      });

      fields = updatedFields;
    } catch (err: any) {
      if (err.revoked) {
        // Mark credential as needing re-authentication
        updateCredential(credentialId, {
          meta: {
            ...credential.meta,
            needs_reauth: true,
            reauth_reason: err.message,
            last_refreshed: new Date().toISOString(),
          },
        });
        throw new Error(`OAuth2 token revoked — credential ${credentialId} marked as needs_reauth`);
      }
      throw err;
    }
  }

  return fields;
}

/**
 * Default fields to exclude from oauth2 credential reads by agents.
 * Agents only need the access_token — never the refresh machinery.
 */
export const OAUTH2_DEFAULT_EXCLUDE_FIELDS = ['refresh_token', 'client_secret', 'client_id', 'token_endpoint'];
