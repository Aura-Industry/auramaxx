/**
 * CLI helper for creating credentials via the server API.
 */

import { serverUrl } from './http';

interface CreateCredentialOpts {
  token: string;
  agentId: string;
  name: string;
  type?: string;
  fields: Array<{ key: string; value: string }>;
}

interface CreateResult {
  success: boolean;
  credential?: { id: string; name: string };
  error?: string;
}

/**
 * Create a credential via POST /credentials.
 * Fields are sent as sensitiveFields (server encrypts them).
 */
export async function createCredentialViaApi(opts: CreateCredentialOpts): Promise<CreateResult> {
  const base = serverUrl();
  const body = {
    agentId: opts.agentId,
    type: opts.type || 'api',
    name: opts.name,
    sensitiveFields: opts.fields.map(f => ({
      key: f.key,
      value: f.value,
      sensitive: true,
    })),
  };

  const res = await fetch(`${base}/credentials`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${opts.token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  const data = await res.json() as CreateResult;
  if (!res.ok) {
    return { success: false, error: data.error || `HTTP ${res.status}` };
  }
  return data;
}

/**
 * Get the primary agent ID.
 */
export async function getPrimaryAgentId(token: string): Promise<string> {
  const base = serverUrl();
  const res = await fetch(`${base}/agents/credential`, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) throw new Error(`Failed to list agents: HTTP ${res.status}`);

  const data = await res.json() as { agents: Array<{ id: string; name: string; isPrimary: boolean }> };
  const primary = data.agents?.find(v => v.isPrimary);
  if (!primary) {
    if (data.agents?.length > 0) return data.agents[0].id;
    throw new Error('No agents found. Run `npx auramaxx` first.');
  }
  return primary.id;
}
