export type CredentialFieldType = 'text' | 'secret' | 'url' | 'email' | 'number';

export type CredentialType =
  | 'login'
  | 'card'
  | 'sso'
  | 'note'
  | 'plain_note'
  | 'hot_wallet'
  | 'api'
  | 'apikey'
  | 'custom'
  | 'passkey'
  | 'oauth2'
  | 'ssh'
  | 'gpg';

export interface CredentialFieldSpec {
  key: string;
  label: string;
  type: CredentialFieldType;
  sensitive: boolean;
  requiredOnCreate?: boolean;
  aliases?: string[];
}

type FieldSchemaMap = Record<CredentialType, CredentialFieldSpec[]>;

export const CREDENTIAL_FIELD_KEYS = {
  login: {
    url: 'url',
    username: 'username',
    password: 'password',
    notes: 'notes',
    totp: 'totp',
  },
  card: {
    cardholder: 'cardholder',
    brand: 'brand',
    billingZip: 'billing_zip',
    last4: 'last4',
    number: 'number',
    cvv: 'cvv',
    expiry: 'expiry',
    notes: 'notes',
  },
  sso: {
    website: 'website',
    provider: 'provider',
    identifier: 'identifier',
  },
  note: {
    content: 'content',
  },
  plain_note: {
    content: 'content',
  },
  hot_wallet: {
    address: 'address',
    privateKey: 'private_key',
    chain: 'chain',
  },
  apikey: {
    key: 'key',
    value: 'value',
  },
  oauth2: {
    accessToken: 'access_token',
    refreshToken: 'refresh_token',
    clientId: 'client_id',
    clientSecret: 'client_secret',
    tokenEndpoint: 'token_endpoint',
    scopes: 'scopes',
    authMethod: 'auth_method',
    expiresAt: 'expires_at',
  },
  ssh: {
    privateKey: 'private_key',
    passphrase: 'passphrase',
    publicKey: 'public_key',
    fingerprint: 'fingerprint',
    keyType: 'key_type',
    hosts: 'hosts',
  },
  gpg: {
    privateKey: 'private_key',
    publicKey: 'public_key',
    fingerprint: 'fingerprint',
    keyId: 'key_id',
    uidEmail: 'uid_email',
    expiresAt: 'expires_at',
  },
  custom: {
    value: 'value',
  },
} as const;

export const CREDENTIAL_FIELD_SCHEMA: FieldSchemaMap = {
  login: [
    { key: CREDENTIAL_FIELD_KEYS.login.url, label: 'URL', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.login.username, label: 'Username', type: 'text', sensitive: false, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.login.password, label: 'Password', type: 'secret', sensitive: true, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.login.notes, label: 'Notes', type: 'text', sensitive: true },
    { key: CREDENTIAL_FIELD_KEYS.login.totp, label: 'TOTP', type: 'secret', sensitive: true, aliases: ['otp'] },
  ],
  card: [
    { key: CREDENTIAL_FIELD_KEYS.card.cardholder, label: 'Cardholder', type: 'text', sensitive: false, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.card.brand, label: 'Brand', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.card.billingZip, label: 'Billing ZIP', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.card.last4, label: 'Last 4', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.card.number, label: 'Number', type: 'text', sensitive: true, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.card.cvv, label: 'CVV', type: 'secret', sensitive: true, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.card.expiry, label: 'Expiry', type: 'text', sensitive: true, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.card.notes, label: 'Notes', type: 'text', sensitive: true },
  ],
  sso: [
    { key: CREDENTIAL_FIELD_KEYS.sso.website, label: 'Website', type: 'text', sensitive: false, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.sso.provider, label: 'Provider', type: 'text', sensitive: false, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.sso.identifier, label: 'Identifier', type: 'text', sensitive: false },
  ],
  note: [
    { key: CREDENTIAL_FIELD_KEYS.note.content, label: 'Content', type: 'text', sensitive: true, requiredOnCreate: true, aliases: ['value'] },
  ],
  plain_note: [
    { key: CREDENTIAL_FIELD_KEYS.plain_note.content, label: 'Content', type: 'text', sensitive: false, requiredOnCreate: true, aliases: ['value'] },
  ],
  hot_wallet: [
    { key: CREDENTIAL_FIELD_KEYS.hot_wallet.address, label: 'Address', type: 'text', sensitive: false, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.hot_wallet.chain, label: 'Chain', type: 'text', sensitive: false, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.hot_wallet.privateKey, label: 'Private Key', type: 'secret', sensitive: true, requiredOnCreate: true },
  ],
  api: [],
  apikey: [
    { key: CREDENTIAL_FIELD_KEYS.apikey.key, label: 'Key', type: 'text', sensitive: false, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.apikey.value, label: 'Value', type: 'secret', sensitive: true, requiredOnCreate: true },
  ],
  custom: [],
  passkey: [],
  oauth2: [
    { key: CREDENTIAL_FIELD_KEYS.oauth2.tokenEndpoint, label: 'Token Endpoint', type: 'url', sensitive: false, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.oauth2.scopes, label: 'Scopes', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.oauth2.authMethod, label: 'Auth Method', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.oauth2.expiresAt, label: 'Expires At', type: 'number', sensitive: false, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.oauth2.accessToken, label: 'Access Token', type: 'secret', sensitive: true, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.oauth2.refreshToken, label: 'Refresh Token', type: 'secret', sensitive: true, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.oauth2.clientId, label: 'Client ID', type: 'secret', sensitive: true, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.oauth2.clientSecret, label: 'Client Secret', type: 'secret', sensitive: true, requiredOnCreate: true },
  ],
  ssh: [
    { key: CREDENTIAL_FIELD_KEYS.ssh.fingerprint, label: 'Fingerprint', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.ssh.keyType, label: 'Key Type', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.ssh.hosts, label: 'Hosts', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.ssh.privateKey, label: 'Private Key', type: 'secret', sensitive: true, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.ssh.passphrase, label: 'Passphrase', type: 'secret', sensitive: true },
    { key: CREDENTIAL_FIELD_KEYS.ssh.publicKey, label: 'Public Key', type: 'text', sensitive: false },
  ],
  gpg: [
    { key: CREDENTIAL_FIELD_KEYS.gpg.fingerprint, label: 'Fingerprint', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.gpg.keyId, label: 'Key ID', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.gpg.uidEmail, label: 'UID Email', type: 'email', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.gpg.expiresAt, label: 'Expires At', type: 'text', sensitive: false },
    { key: CREDENTIAL_FIELD_KEYS.gpg.privateKey, label: 'Private Key', type: 'secret', sensitive: true, requiredOnCreate: true },
    { key: CREDENTIAL_FIELD_KEYS.gpg.publicKey, label: 'Public Key', type: 'text', sensitive: false },
  ],
};

export const NOTE_CONTENT_KEY = CREDENTIAL_FIELD_KEYS.note.content;

export const CREDENTIAL_PRIMARY_FIELD_KEY: Record<CredentialType, string> = {
  login: CREDENTIAL_FIELD_KEYS.login.password,
  card: CREDENTIAL_FIELD_KEYS.card.number,
  sso: CREDENTIAL_FIELD_KEYS.sso.website,
  note: CREDENTIAL_FIELD_KEYS.note.content,
  plain_note: CREDENTIAL_FIELD_KEYS.plain_note.content,
  hot_wallet: CREDENTIAL_FIELD_KEYS.hot_wallet.privateKey,
  api: CREDENTIAL_FIELD_KEYS.apikey.value,
  apikey: CREDENTIAL_FIELD_KEYS.apikey.value,
  custom: CREDENTIAL_FIELD_KEYS.custom.value,
  passkey: CREDENTIAL_FIELD_KEYS.ssh.privateKey,
  oauth2: CREDENTIAL_FIELD_KEYS.oauth2.accessToken,
  ssh: CREDENTIAL_FIELD_KEYS.ssh.privateKey,
  gpg: CREDENTIAL_FIELD_KEYS.gpg.privateKey,
};

export function getCredentialPrimaryFieldKey(type: string): string {
  if (!isCredentialType(type)) return 'value';
  return CREDENTIAL_PRIMARY_FIELD_KEY[type] || 'value';
}

export function getCredentialPrimaryFieldSpec(type: string): CredentialFieldSpec | undefined {
  if (!isCredentialType(type)) return undefined;
  const primaryKey = getCredentialPrimaryFieldKey(type);
  return CREDENTIAL_FIELD_SCHEMA[type].find((field) => field.key === primaryKey);
}

type CredentialFieldLike = { key: string };

const SCHEMA_KEY_LOOKUP = Object.fromEntries(
  (Object.entries(CREDENTIAL_FIELD_SCHEMA) as Array<[CredentialType, CredentialFieldSpec[]]>).map(([type, fields]) => {
    const lookup = new Map<string, string>();
    for (const field of fields) {
      lookup.set(field.key.toLowerCase(), field.key);
      for (const alias of field.aliases || []) {
        lookup.set(alias.toLowerCase(), field.key);
      }
    }
    return [type, lookup];
  }),
) as Record<CredentialType, Map<string, string>>;

function isCredentialType(value: string): value is CredentialType {
  return Object.prototype.hasOwnProperty.call(CREDENTIAL_FIELD_SCHEMA, value);
}

export function canonicalizeCredentialFieldKey(type: string, key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return trimmed;
  if (!isCredentialType(type)) return trimmed;

  const canonical = SCHEMA_KEY_LOOKUP[type].get(trimmed.toLowerCase());
  return canonical || trimmed;
}

export function normalizeCredentialFieldsForType<T extends CredentialFieldLike>(
  type: string,
  fields: readonly T[],
): T[] {
  if (!Array.isArray(fields) || fields.length === 0) return [];

  const normalized: T[] = [];
  const indexByKey = new Map<string, number>();

  for (const field of fields) {
    const canonicalKey = canonicalizeCredentialFieldKey(type, field.key);
    const normalizedField = canonicalKey === field.key
      ? field
      : ({ ...field, key: canonicalKey } as T);
    const existingIndex = indexByKey.get(canonicalKey);

    if (existingIndex === undefined) {
      indexByKey.set(canonicalKey, normalized.length);
      normalized.push(normalizedField);
      continue;
    }

    normalized[existingIndex] = normalizedField;
  }

  return normalized;
}

export function getCredentialFieldValue(
  type: string,
  fields: Array<{ key: string; value: string }>,
  key: string,
): string | undefined {
  const normalized = normalizeCredentialFieldsForType(type, fields);
  const canonicalKey = canonicalizeCredentialFieldKey(type, key);
  return normalized.find((field) => field.key === canonicalKey)?.value;
}

/**
 * Look up the schema spec for a given credential type + field key.
 * Returns the CredentialFieldSpec if found, or undefined for unknown types/keys.
 */
export function getCredentialFieldSpec(type: string, key: string): CredentialFieldSpec | undefined {
  if (!isCredentialType(type)) return undefined;
  const canonicalKey = canonicalizeCredentialFieldKey(type, key);
  return CREDENTIAL_FIELD_SCHEMA[type].find((field) => field.key === canonicalKey);
}
