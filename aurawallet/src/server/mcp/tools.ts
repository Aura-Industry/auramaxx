/**
 * MCP Tool Definitions
 * ====================
 * Provider-agnostic tool definitions + HTTP handler for executing wallet API calls.
 * Single source of truth — both the MCP server and SDK tool-use loop read from here.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getErrorMessage } from '../lib/error';
import { redactJsonString, redactSensitiveData } from '../lib/redaction';
import { encryptPassword, generateAgentKeypair } from '../cli/transport-client';

/** Provider-agnostic tool definition */
export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** All available tools */
export const TOOLS: ToolDef[] = [
  {
    name: 'api',
    description:
      'Call the AuraMaxx API. Common endpoints: GET /wallets, GET /token/search?q=PEPE&chain=base (find contract by ticker/name), POST /wallet/create, POST /send, POST /swap, POST /fund, GET /token/:tokenAddress/balance/:walletAddress (check any address\'s token balance). If you have no token yet, use socket bootstrap (preferred) or set AURA_TOKEN for CI/ops. Read the docs://api resource for the full endpoint reference.',
    parameters: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'HTTP method',
        },
        endpoint: {
          type: 'string',
          description: 'API path, e.g. /wallets',
        },
        body: {
          type: 'object',
          description: 'POST/PUT/PATCH request body (optional)',
        },
      },
      required: ['method', 'endpoint'],
    },
  },
  {
    name: 'status',
    description: 'Get Aura setup/unlock health state (CLI equivalent: `auramaxx status`).',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_secrets',
    description: 'List credentials with optional query filters (CLI equivalent: `auramaxx agent list --q ...`).',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Optional search query' },
        tag: { type: 'string', description: 'Optional tag filter' },
        agent: { type: 'string', description: 'Optional agent id filter' },
        lifecycle: { type: 'string', enum: ['active', 'archive', 'recently_deleted'], description: 'Optional lifecycle filter' },
      },
    },
  },
  {
    name: 'register_agent',
    description: 'Create/register a subsequent local agent (POST /setup/agent). Requires admin token and primary unlocked.',
    parameters: {
      type: 'object',
      properties: {
        password: { type: 'string', description: 'Password for the new agent (min 8 chars)' },
        name: { type: 'string', description: 'Optional agent display name' },
      },
      required: ['password'],
    },
  },
  {
    name: 'register',
    description: 'Register an existing local agent on the hub. Uses /agent-hub/:agentId/register by default, or /join when hubUrl is provided.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        hubUrl: { type: 'string', description: 'Optional hub URL. When provided, uses /agent-hub/:agentId/join' },
        label: { type: 'string', description: 'Optional display label for hub join' },
      },
    },
  },
  {
    name: 'social_register',
    description: 'Register an existing local agent on the hub (legacy alias). Uses /agent-hub/:agentId/register by default, or /join when hubUrl is provided.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        hubUrl: { type: 'string', description: 'Optional hub URL. When provided, uses /agent-hub/:agentId/join' },
        label: { type: 'string', description: 'Optional display label for hub join' },
      },
    },
  },
  {
    name: 'unregister',
    description: 'Leave/unregister from a specific hub (POST /agent-hub/:agentId/leave). Requires hubUrl.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        hubUrl: { type: 'string', description: 'Hub URL to leave (required)' },
      },
      required: ['hubUrl'],
    },
  },
  {
    name: 'social_unregister',
    description: 'Leave/unregister from a specific hub (legacy alias). Requires hubUrl.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        hubUrl: { type: 'string', description: 'Hub URL to leave (required)' },
      },
      required: ['hubUrl'],
    },
  },
  {
    name: 'social_post',
    description: 'Create a social post (POST /social/post).',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        text: { type: 'string', description: 'Post text' },
        embeds: { type: 'array', description: 'Optional embed URLs as an array of strings' },
        parentPostHash: { type: 'string', description: 'Optional parent post hash for replies' },
        mentions: { type: 'array', description: 'Optional mention indices as an array of numbers' },
        hubUrl: { type: 'string', description: 'Optional hub URL override' },
      },
      required: ['text'],
    },
  },
  {
    name: 'social_feed',
    description: 'Read local social feed (GET /social/feed).',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        type: { type: 'string', description: 'Optional message type filter (typically post_add)' },
        hubUrl: { type: 'string', description: 'Optional hub URL override' },
        limit: { type: 'number', description: 'Optional page size' },
        offset: { type: 'number', description: 'Optional pagination offset' },
      },
    },
  },
  {
    name: 'social_follow',
    description: 'Follow a target public key (POST /social/follow).',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        targetPublicKey: { type: 'string', description: 'Target public key to follow' },
        hubUrl: { type: 'string', description: 'Optional hub URL override' },
      },
      required: ['targetPublicKey'],
    },
  },
  {
    name: 'social_unfollow',
    description: 'Unfollow a target public key (POST /social/unfollow).',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        targetPublicKey: { type: 'string', description: 'Target public key to unfollow' },
        hubUrl: { type: 'string', description: 'Optional hub URL override' },
      },
      required: ['targetPublicKey'],
    },
  },
  {
    name: 'social_react',
    description: 'React to a post (POST /social/react).',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        postHash: { type: 'string', description: 'Target post hash' },
        reactionType: { type: 'string', description: 'Reaction type (for example: like)' },
        hubUrl: { type: 'string', description: 'Optional hub URL override' },
      },
      required: ['postHash', 'reactionType'],
    },
  },
  {
    name: 'social_followers',
    description: 'List local followers cache (GET /social/followers).',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        hubUrl: { type: 'string', description: 'Optional hub URL override' },
      },
    },
  },
  {
    name: 'social_following',
    description: 'List local following set (GET /social/following).',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        hubUrl: { type: 'string', description: 'Optional hub URL override' },
      },
    },
  },
  {
    name: 'social_notifications',
    description: 'List social notifications and, by default, mark fetched notification ids as read.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Optional agent id filter' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        limit: { type: 'number', description: 'Optional page size' },
        unreadOnly: { type: 'boolean', description: 'When true, fetch only unread notifications (default: true)' },
        autoRead: { type: 'boolean', description: 'When true, mark fetched notification ids as read (default: true)' },
      },
    },
  },
  {
    name: 'social_status',
    description: 'Read outbound social sync status counters (GET /social/status).',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id (for example: "primary")' },
        agentAddress: { type: 'string', description: 'Optional EVM/Solana address; resolves to agentId when agentId is omitted' },
        hubUrl: { type: 'string', description: 'Optional hub URL override' },
      },
    },
  },
];

/**
 * Convert JSON Schema properties to Zod schema shape.
 * Used by the MCP server to bridge provider-agnostic tool defs with the MCP SDK's Zod requirement.
 */
export function jsonSchemaToZod(
  props: Record<string, unknown>,
  requiredFields: string[],
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(requiredFields);

  for (const [key, schema] of Object.entries(props)) {
    const s = schema as Record<string, unknown>;
    let zodType: z.ZodTypeAny;

    if (s.type === 'string') {
      zodType = s.enum
        ? z.enum(s.enum as [string, ...string[]])
        : z.string();
    } else if (s.type === 'object') {
      zodType = z.record(z.unknown());
    } else if (s.type === 'array') {
      zodType = z.array(z.unknown());
    } else if (s.type === 'number') {
      zodType = z.number();
    } else if (s.type === 'boolean') {
      zodType = z.boolean();
    } else {
      zodType = z.unknown();
    }

    if (s.description) {
      zodType = zodType.describe(s.description as string);
    }

    shape[key] = required.has(key) ? zodType : zodType.optional();
  }

  return shape;
}

/** Base URL for the wallet server (configurable for testing) */
const WALLET_BASE_URL = process.env.WALLET_SERVER_URL || 'http://127.0.0.1:4242';

/** Max response size to prevent context bloat */
const MAX_RESPONSE_SIZE = 4096;

/** Timeout per tool call */
const TOOL_TIMEOUT_MS = 10_000;

const BLOCKED_API_ENDPOINT_PATTERNS: RegExp[] = [
  /^\/credentials\/[^/]+\/secrets$/,
  /^\/credentials\/[^/]+\/totp$/,
  /^\/credential-shares\/[^/]+\/read$/,
  /^\/unlock(?:\/|$)/,
];

function isAuthClaimEndpoint(endpointPath: string): boolean {
  if (!endpointPath.startsWith('/auth/')) return false;
  const suffix = endpointPath.slice('/auth/'.length);
  if (!suffix) return false;
  if (suffix === 'connect' || suffix === 'pending' || suffix === 'validate') return false;
  if (suffix.startsWith('internal')) return false;
  return !suffix.includes('/');
}

function sanitizeApiResponse(text: string): string {
  if (!text) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    return JSON.stringify(redactSensitiveData(parsed));
  } catch {
    return redactJsonString(text);
  }
}

function readOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(input: Record<string, unknown>, key: string): string | null {
  const value = readOptionalString(input, key);
  return value ?? null;
}

function readOptionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return undefined;
}

function readOptionalNonNegativeInt(input: Record<string, unknown>, key: string): number | null | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function readOptionalStringArray(input: Record<string, unknown>, key: string): string[] | null | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => typeof entry === 'string')) return null;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function readOptionalNumberArray(input: Record<string, unknown>, key: string): number[] | null | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;
  const parsed = value.map((entry) => Number(entry));
  if (!parsed.every((entry) => Number.isFinite(entry))) return null;
  return parsed.map((entry) => Math.floor(entry));
}

function buildQuery(path: string, query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

interface SetupAgentRecord {
  id: string;
  address?: string;
  solanaAddress?: string;
}

async function resolveAgentIdFromInput(
  input: Record<string, unknown>,
  token: string | undefined,
  required: boolean,
): Promise<{ agentId?: string; error?: string }> {
  const directAgentId = readOptionalString(input, 'agentId');
  if (directAgentId) return { agentId: directAgentId };

  const agentAddress = readOptionalString(input, 'agentAddress');
  if (!agentAddress) {
    return required
      ? { error: 'agentId or agentAddress is required' }
      : {};
  }

  const raw = await executeWalletApi({ method: 'GET', endpoint: '/setup/agents' }, token);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { error: 'Failed to parse /setup/agents response while resolving agentAddress' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Invalid /setup/agents response while resolving agentAddress' };
  }

  const parsedObj = parsed as Record<string, unknown>;
  if (parsedObj.error) {
    return { error: `Failed to resolve agentAddress: ${String(parsedObj.error)}` };
  }

  const agents = Array.isArray(parsedObj.agents) ? parsedObj.agents : [];
  const normalizedAddress = agentAddress.toLowerCase();
  const match = agents
    .filter((entry): entry is SetupAgentRecord => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).id === 'string')
    .find((entry) => {
      const evm = typeof entry.address === 'string' ? entry.address.toLowerCase() : '';
      const sol = typeof entry.solanaAddress === 'string' ? entry.solanaAddress.toLowerCase() : '';
      return evm === normalizedAddress || sol === normalizedAddress;
    });

  if (!match?.id) {
    return { error: `No agent found for address ${agentAddress}` };
  }

  return { agentId: match.id };
}


/** Format for Anthropic SDK */
export function toAnthropicTools(): Anthropic.Tool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: t.parameters.type as 'object',
      properties: t.parameters.properties,
      required: t.parameters.required,
    },
  }));
}

/** Format for OpenAI SDK */
export function toOpenAITools(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: ToolDef['parameters'] };
}> {
  return TOOLS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Execute a tool call — makes HTTP request to wallet server.
 * Validates endpoint, enforces timeout, truncates response.
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  token?: string,
): Promise<string> {
  if (toolName === 'status') {
    return executeTypedWalletApi('status', 'GET', '/setup', undefined, token);
  }

  if (toolName === 'list_secrets') {
    const q = typeof input.q === 'string' ? input.q.trim() : '';
    const tag = typeof input.tag === 'string' ? input.tag.trim() : '';
    const agent = typeof input.agent === 'string' ? input.agent.trim() : '';
    const lifecycle = typeof input.lifecycle === 'string' ? input.lifecycle.trim() : '';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    if (agent) params.set('agent', agent);
    if (lifecycle) params.set('location', lifecycle);
    const endpoint = params.toString() ? `/credentials?${params.toString()}` : '/credentials';
    return executeTypedWalletApi('list_secrets', 'GET', endpoint, undefined, token);
  }

  if (toolName === 'register_agent') {
    const password = readRequiredString(input, 'password');
    if (!password) return JSON.stringify({ error: 'password is required' });
    if (password.length < 8) return JSON.stringify({ error: 'password must be at least 8 characters' });

    const connectRaw = await executeWalletApi({ method: 'GET', endpoint: '/auth/connect' }, token);
    let connectParsed: unknown;
    try {
      connectParsed = JSON.parse(connectRaw) as unknown;
    } catch {
      return JSON.stringify({ error: 'Failed to parse /auth/connect response' });
    }
    if (!connectParsed || typeof connectParsed !== 'object' || Array.isArray(connectParsed)) {
      return JSON.stringify({ error: 'Invalid /auth/connect response' });
    }

    const connectObj = connectParsed as Record<string, unknown>;
    if (connectObj.error) {
      return JSON.stringify({ error: `Failed to fetch transport public key: ${String(connectObj.error)}` });
    }

    const publicKey = typeof connectObj.publicKey === 'string' ? connectObj.publicKey : '';
    if (!publicKey.trim()) {
      return JSON.stringify({ error: 'Missing publicKey in /auth/connect response' });
    }

    const encrypted = encryptPassword(password, publicKey);
    const { publicKey: agentPubkey } = generateAgentKeypair();
    const body: Record<string, unknown> = { encrypted, pubkey: agentPubkey };
    const name = readOptionalString(input, 'name');
    if (name) body.name = name;

    return executeTypedWalletApi('register_agent', 'POST', '/setup/agent', body, token);
  }

  if (toolName === 'register' || toolName === 'social_register') {
    const resolved = await resolveAgentIdFromInput(input, token, true);
    if (resolved.error) return JSON.stringify({ error: resolved.error });
    const agentId = resolved.agentId!;
    const hubUrl = readOptionalString(input, 'hubUrl');
    const label = readOptionalString(input, 'label');

    if (hubUrl) {
      const body: Record<string, unknown> = { hubUrl };
      if (label) body.label = label;
      return executeTypedWalletApi(
        toolName,
        'POST',
        `/agent-hub/${encodeURIComponent(agentId)}/join`,
        body,
        token,
      );
    }

    return executeTypedWalletApi(
      toolName,
      'POST',
      `/agent-hub/${encodeURIComponent(agentId)}/register`,
      undefined,
      token,
    );
  }

  if (toolName === 'unregister' || toolName === 'social_unregister') {
    const resolved = await resolveAgentIdFromInput(input, token, true);
    if (resolved.error) return JSON.stringify({ error: resolved.error });
    const agentId = resolved.agentId!;
    const hubUrl = readRequiredString(input, 'hubUrl');
    if (!hubUrl) return JSON.stringify({ error: 'hubUrl is required' });

    return executeTypedWalletApi(
      toolName,
      'POST',
      `/agent-hub/${encodeURIComponent(agentId)}/leave`,
      { hubUrl },
      token,
    );
  }

  if (toolName === 'social_post') {
    const resolved = await resolveAgentIdFromInput(input, token, true);
    if (resolved.error) return JSON.stringify({ error: resolved.error });
    const agentId = resolved.agentId!;
    const text = readRequiredString(input, 'text');
    if (!text) return JSON.stringify({ error: 'text is required' });

    const embeds = readOptionalStringArray(input, 'embeds');
    if (embeds === null) return JSON.stringify({ error: 'embeds must be an array of strings' });
    const mentions = readOptionalNumberArray(input, 'mentions');
    if (mentions === null) return JSON.stringify({ error: 'mentions must be an array of numbers' });

    const body: Record<string, unknown> = { agentId, text };
    const hubUrl = readOptionalString(input, 'hubUrl');
    const parentPostHash = readOptionalString(input, 'parentPostHash');
    if (hubUrl) body.hubUrl = hubUrl;
    if (parentPostHash) body.parentPostHash = parentPostHash;
    if (embeds && embeds.length > 0) body.embeds = embeds;
    if (mentions && mentions.length > 0) body.mentions = mentions;

    return executeTypedWalletApi('social_post', 'POST', '/social/post', body, token);
  }

  if (toolName === 'social_feed') {
    const resolved = await resolveAgentIdFromInput(input, token, true);
    if (resolved.error) return JSON.stringify({ error: resolved.error });
    const agentId = resolved.agentId!;
    const limit = readOptionalNonNegativeInt(input, 'limit');
    if (limit === null) return JSON.stringify({ error: 'limit must be a non-negative number' });
    const offset = readOptionalNonNegativeInt(input, 'offset');
    if (offset === null) return JSON.stringify({ error: 'offset must be a non-negative number' });
    const endpoint = buildQuery('/social/feed', {
      agentId,
      type: readOptionalString(input, 'type'),
      hubUrl: readOptionalString(input, 'hubUrl'),
      limit,
      offset,
    });
    return executeTypedWalletApi('social_feed', 'GET', endpoint, undefined, token);
  }

  if (toolName === 'social_follow' || toolName === 'social_unfollow') {
    const resolved = await resolveAgentIdFromInput(input, token, true);
    if (resolved.error) return JSON.stringify({ error: resolved.error });
    const agentId = resolved.agentId!;
    const targetPublicKey = readRequiredString(input, 'targetPublicKey');
    if (!targetPublicKey) return JSON.stringify({ error: 'targetPublicKey is required' });

    const body: Record<string, unknown> = { agentId, targetPublicKey };
    const hubUrl = readOptionalString(input, 'hubUrl');
    if (hubUrl) body.hubUrl = hubUrl;

    const endpoint = toolName === 'social_follow' ? '/social/follow' : '/social/unfollow';
    return executeTypedWalletApi(toolName, 'POST', endpoint, body, token);
  }

  if (toolName === 'social_react') {
    const resolved = await resolveAgentIdFromInput(input, token, true);
    if (resolved.error) return JSON.stringify({ error: resolved.error });
    const agentId = resolved.agentId!;
    const postHash = readRequiredString(input, 'postHash');
    const reactionType = readRequiredString(input, 'reactionType');
    if (!postHash) return JSON.stringify({ error: 'postHash is required' });
    if (!reactionType) return JSON.stringify({ error: 'reactionType is required' });

    const body: Record<string, unknown> = { agentId, postHash, reactionType };
    const hubUrl = readOptionalString(input, 'hubUrl');
    if (hubUrl) body.hubUrl = hubUrl;
    return executeTypedWalletApi('social_react', 'POST', '/social/react', body, token);
  }

  if (toolName === 'social_followers' || toolName === 'social_following') {
    const resolved = await resolveAgentIdFromInput(input, token, true);
    if (resolved.error) return JSON.stringify({ error: resolved.error });
    const agentId = resolved.agentId!;
    const route = toolName === 'social_followers' ? '/social/followers' : '/social/following';
    const endpoint = buildQuery(route, {
      agentId,
      hubUrl: readOptionalString(input, 'hubUrl'),
    });
    return executeTypedWalletApi(toolName, 'GET', endpoint, undefined, token);
  }

  if (toolName === 'social_status') {
    const resolved = await resolveAgentIdFromInput(input, token, true);
    if (resolved.error) return JSON.stringify({ error: resolved.error });
    const agentId = resolved.agentId!;
    const endpoint = buildQuery('/social/status', {
      agentId,
      hubUrl: readOptionalString(input, 'hubUrl'),
    });
    return executeTypedWalletApi('social_status', 'GET', endpoint, undefined, token);
  }

  if (toolName === 'social_notifications') {
    const resolved = await resolveAgentIdFromInput(input, token, false);
    if (resolved.error) return JSON.stringify({ error: resolved.error });
    const limit = readOptionalNonNegativeInt(input, 'limit');
    if (limit === null) return JSON.stringify({ error: 'limit must be a non-negative number' });
    const unreadOnly = readOptionalBoolean(input, 'unreadOnly') ?? true;
    const autoRead = readOptionalBoolean(input, 'autoRead') ?? true;
    const endpoint = buildQuery('/social/notifications', {
      agentId: resolved.agentId,
      limit,
      unreadOnly,
    });

    const raw = await executeWalletApi({ method: 'GET', endpoint }, token);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return JSON.stringify({ success: true, tool: 'social_notifications', data: raw });
    }

    const parsedObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
    if (parsedObj?.error) {
      return JSON.stringify({ success: false, tool: 'social_notifications', error: parsedObj.error });
    }

    const ids = Array.isArray(parsedObj?.notifications)
      ? (parsedObj?.notifications as unknown[])
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry) => {
          const id = (entry as Record<string, unknown>).id;
          return typeof id === 'string' ? id.trim() : '';
        })
        .filter(Boolean)
      : [];

    let updated = 0;
    let autoReadError: string | undefined;
    if (autoRead && ids.length > 0) {
      const readRaw = await executeWalletApi({
        method: 'POST',
        endpoint: '/social/notifications/read',
        body: { ids },
      }, token);
      try {
        const readParsed = JSON.parse(readRaw) as unknown;
        if (readParsed && typeof readParsed === 'object' && !Array.isArray(readParsed)) {
          const readObj = readParsed as Record<string, unknown>;
          if (readObj.error) {
            autoReadError = String(readObj.error);
          } else if (typeof readObj.updated === 'number') {
            updated = readObj.updated;
          }
        }
      } catch {
        autoReadError = 'Failed to parse notifications/read response';
      }
    }

    return JSON.stringify({
      success: true,
      tool: 'social_notifications',
      data: parsed,
      autoRead: {
        enabled: autoRead,
        ids: ids.length,
        updated,
        ...(autoReadError ? { error: autoReadError } : {}),
      },
    });
  }

  if (toolName !== 'api') {
    return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }

  return executeWalletApi(input, token);
}

async function executeTypedWalletApi(
  tool: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  endpoint: string,
  body: Record<string, unknown> | undefined,
  token?: string,
): Promise<string> {
  const raw = await executeWalletApi({ method, endpoint, ...(body ? { body } : {}) }, token);
  try {
    const parsed = JSON.parse(raw) as unknown;
    const maybeObj = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : undefined;
    if (maybeObj?.error) {
      return JSON.stringify({ success: false, tool, error: maybeObj.error });
    }
    return JSON.stringify({ success: true, tool, data: parsed });
  } catch {
    if (raw.includes('"error"')) {
      return JSON.stringify({ success: false, tool, error: raw });
    }
    return JSON.stringify({ success: true, tool, data: raw });
  }
}

/** Execute a wallet_api tool call */
async function executeWalletApi(
  input: Record<string, unknown>,
  token?: string,
): Promise<string> {
  const { method, endpoint, body } = input as {
    method: string;
    endpoint: string;
    body?: Record<string, unknown>;
  };

  // Validate endpoint
  if (!endpoint || typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
    return JSON.stringify({ error: 'endpoint must start with /' });
  }

  const [endpointPath] = endpoint.split('?');

  // Block internal-only endpoints (defense-in-depth)
  const BLOCKED_ENDPOINTS = ['/auth/internal', '/apps/internal', '/strategies/internal'];
  if (BLOCKED_ENDPOINTS.some(prefix => endpointPath.startsWith(prefix))) {
    return JSON.stringify({ error: 'This endpoint is not accessible via MCP' });
  }

  if (isAuthClaimEndpoint(endpointPath) || BLOCKED_API_ENDPOINT_PATTERNS.some((pattern) => pattern.test(endpointPath))) {
    return JSON.stringify({
      error: 'Sensitive endpoint is blocked in MCP generic api. Use dedicated auth/secret tools and scoped read flows.',
    });
  }

  // Validate method
  const upperMethod = (method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(upperMethod)) {
    return JSON.stringify({ error: 'method must be GET, POST, PUT, PATCH, or DELETE' });
  }

  const url = `${WALLET_BASE_URL}${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);

    const fetchOpts: RequestInit = {
      method: upperMethod,
      headers,
      signal: controller.signal,
    };

    if ((upperMethod === 'POST' || upperMethod === 'PUT' || upperMethod === 'PATCH') && body) {
      fetchOpts.body = JSON.stringify(body);
    }

    const res = await fetch(url, fetchOpts);
    clearTimeout(timeout);

    const text = await res.text();

    // Truncate to prevent context bloat, except encrypted credential reads
    // where truncation breaks client-side decryption.
    const bypassTruncation = /^\/credentials\/[^/]+\/read(?:\?.*)?$/.test(endpoint);
    if (!bypassTruncation && text.length > MAX_RESPONSE_SIZE) {
      return sanitizeApiResponse(text.slice(0, MAX_RESPONSE_SIZE) + '\n...[truncated]');
    }

    return bypassTruncation ? text : sanitizeApiResponse(text);
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
      return JSON.stringify({ error: `Wallet server not reachable at ${WALLET_BASE_URL}. Is it running? Start it with: npx auramaxx` });
    }
    return JSON.stringify({ error: `API call failed: ${msg}` });
  }
}
