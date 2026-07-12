import {
  bootstrapViaAuthRequest,
  bootstrapViaSocket,
  generateEphemeralKeypair,
  type ProfileIssuanceSelection,
} from '../../lib/credential-transport';
import { getErrorMessage } from '../../lib/error';
import { serverUrl } from './http';

type JsonObject = Record<string, unknown>;

export interface ProfileSelectionInput {
  profile?: string;
  profileVersion?: string;
  profileOverridesRaw?: string;
}

export interface ResolveCliBearerTokenOptions {
  explicitToken?: string;
  agentId: string;
  rerunCommand: string;
  selection: ProfileIssuanceSelection;
}

export function parseProfileSelectionInput(input: ProfileSelectionInput): ProfileIssuanceSelection {
  let profileOverrides: JsonObject | undefined;
  if (input.profileOverridesRaw) {
    const parsed = JSON.parse(input.profileOverridesRaw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--profile-overrides must be a JSON object');
    }
    profileOverrides = parsed as JsonObject;
  }

  return {
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.profileVersion ? { profileVersion: input.profileVersion } : {}),
    ...(profileOverrides ? { profileOverrides } : {}),
  };
}

export async function resolveCliBearerToken(options: ResolveCliBearerTokenOptions): Promise<string> {
  if (options.explicitToken) return options.explicitToken;

  const keypair = generateEphemeralKeypair();

  if (options.selection.profile) {
    const result = await bootstrapViaAuthRequest(serverUrl(), options.agentId, keypair, {
      ...options.selection,
      noWait: true,
      onStatus: (message) => console.error(message),
    });
    if (result.approveUrl) {
      console.error(`Approve at: ${result.approveUrl}`);
    }
    console.error(`After approval, re-run with: AURA_TOKEN=<token> ${options.rerunCommand}`);
    console.error(`Or use: npx auramaxx auth request --profile ${options.selection.profile} --raw-token`);
    process.exit(1);
  }

  try {
    return await bootstrapViaSocket(options.agentId, keypair);
  } catch (socketErr) {
    return bootstrapViaAuthRequest(serverUrl(), options.agentId, keypair, {
      ...options.selection,
      onStatus: (message) => console.error(message),
    }).catch((authErr) => {
      throw new Error(`${getErrorMessage(socketErr)}\n${getErrorMessage(authErr)}`);
    });
  }
}

