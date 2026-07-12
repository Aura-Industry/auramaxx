import { NOTE_CONTENT_KEY } from '../../../shared/credential-field-schema';
import { START_BANNER_QUOTES } from '../../lib/startBannerQuotes';
import { createCredential, listCredentials } from './credentials';

export const OURSECRET_NOTE_NAME = 'OURSECRET';

function randomStartBannerQuote(randomFn: () => number = Math.random): string {
  const sample = randomFn();
  if (!Number.isFinite(sample)) return START_BANNER_QUOTES[0];
  const normalized = Math.abs(sample % 1);
  const index = Math.floor(normalized * START_BANNER_QUOTES.length);
  return START_BANNER_QUOTES[index] ?? START_BANNER_QUOTES[0];
}

const WORKING_WITH_SECRETS_COMMANDS = [
  'aura list',
  'aura get OURSECRET',
  'aura set OURSECRET 123',
  'aura share OURSECRET --expires-after 24h',
  'aura inject OURSECRET --env HIDETHIS -- printenv HIDETHIS',
] as const;

function renderSecretCommandNote(title: string): string {
  return `${title}
${WORKING_WITH_SECRETS_COMMANDS.map((command) => `- ${command}`).join('\n')}
`;
}

export const OURSECRET_NOTE_CONTENT = randomStartBannerQuote();

export const DONTLOOK_NOTE_NAME = 'DONTLOOK';

export const DONTLOOK_NOTE_CONTENT = `# never stopping auramaxxing 🗿🖤

from [@nicoletteduclar](https://x.com/nicoletteduclar), with love`;

export const WORKING_WITH_SECRETS_NOTE_NAME = 'WORKING_WITH_SECRETS';

export const WORKING_WITH_SECRETS_NOTE_CONTENT = renderSecretCommandNote('Working with secrets');

function hasSeededNote(agentId: string, name: string): boolean {
  const hasLegacyNote = listCredentials({ agentId, type: 'note' })
    .some((credential) => credential.name.trim().toUpperCase() === name);
  const hasPlainNote = listCredentials({ agentId, type: 'plain_note' })
    .some((credential) => credential.name.trim().toUpperCase() === name);

  return hasLegacyNote || hasPlainNote;
}

function ensureSeededNote(agentId: string, name: string, content: string, type: 'note' | 'plain_note' = 'note'): { created: boolean } {
  if (hasSeededNote(agentId, name)) {
    return { created: false };
  }

  const meta: Record<string, unknown> = {
    tags: ['onboarding', 'docs', 'agents'],
    system: true,
  };

  if (type === 'plain_note') {
    meta[NOTE_CONTENT_KEY] = content;
  }

  createCredential(
    agentId,
    type,
    name,
    meta,
    type === 'note'
      ? [{ key: NOTE_CONTENT_KEY, value: content, type: 'text', sensitive: true }]
      : [],
  );

  return { created: true };
}

export function ensureOurSecretForAgent(agentId: string): { created: boolean } {
  return ensureSeededNote(agentId, OURSECRET_NOTE_NAME, OURSECRET_NOTE_CONTENT, 'plain_note');
}

export function ensureDontLookForAgent(agentId: string): { created: boolean } {
  return ensureSeededNote(agentId, DONTLOOK_NOTE_NAME, DONTLOOK_NOTE_CONTENT, 'note');
}

export function ensureWorkingWithSecretsForAgent(agentId: string): { created: boolean } {
  return ensureSeededNote(agentId, WORKING_WITH_SECRETS_NOTE_NAME, WORKING_WITH_SECRETS_NOTE_CONTENT, 'plain_note');
}
