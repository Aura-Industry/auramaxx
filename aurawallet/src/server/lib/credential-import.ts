/**
 * Credential Import — Parse external password manager exports
 * ============================================================
 *
 * Normalizes CSV exports from 1Password, Bitwarden, LastPass, Chrome,
 * and generic CSV into ImportedCredential[], ready for agent import.
 */

import { parse } from 'csv-parse/sync';
import { CredentialType, CredentialField } from '../types';
import { listCredentials } from './credentials';
import { getCredentialFieldSpec } from '../../../shared/credential-field-schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportedField {
  key: string;
  value: string;
  sensitive: boolean;
}

export interface ImportedCredential {
  name: string;
  type: CredentialType;
  url?: string;
  fields: ImportedField[];
  tags?: string[];
}

export interface ColumnMapping {
  title?: string;
  url?: string;
  username?: string;
  password?: string;
  notes?: string;
}

export interface SplitResult {
  meta: Record<string, unknown>;
  sensitiveFields: CredentialField[];
}

export type ImportFormat =
  | '1password-csv'
  | '1password-json'
  | '1password-1pux'
  | 'bitwarden-csv'
  | 'bitwarden-json'
  | 'lastpass-csv'
  | 'icloud-csv'
  | 'chrome-csv'
  | 'chrome-json'
  | 'firefox-csv'
  | 'firefox-json'
  | 'generic-csv';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive field sensitivity from the credential schema; default to false for unknown fields. */
function fieldSensitive(type: CredentialType, key: string): boolean {
  return getCredentialFieldSpec(type, key)?.sensitive ?? false;
}

/** Strip UTF-8 BOM if present */
function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseCsvRows(csv: string): Record<string, string>[] {
  const cleaned = stripBOM(csv);
  return parse(cleaned, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];
}

function normalizeColumnName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getRowValue(row: Record<string, string>, aliases: string[]): string {
  const lookup = new Map<string, string>();
  for (const [key, value] of Object.entries(row)) {
    lookup.set(normalizeColumnName(key), value);
  }
  for (const alias of aliases) {
    const found = lookup.get(normalizeColumnName(alias));
    if (found !== undefined && String(found).trim() !== '') {
      return String(found).trim();
    }
  }
  return '';
}

/** Normalize URL for duplicate comparison: strip protocol, www., trailing slash */
export function normalizeUrl(url: string): string {
  if (!url) return '';
  let u = url.trim().toLowerCase();
  // strip protocol
  u = u.replace(/^https?:\/\//, '');
  // strip www.
  u = u.replace(/^www\./, '');
  // strip trailing slash
  u = u.replace(/\/+$/, '');
  return u;
}

/**
 * Split ImportedField[] into meta (non-sensitive) + sensitiveFields (sensitive).
 * The CredentialField objects get a default type based on key.
 */
export function splitFields(
  fields: ImportedField[],
  url?: string,
  tags?: string[]
): SplitResult {
  const meta: Record<string, unknown> = {};
  const sensitiveFields: CredentialField[] = [];

  if (url) meta.url = url;
  if (tags && tags.length > 0) meta.tags = tags;

  for (const f of fields) {
    if (!f.value && f.value !== '') continue; // skip undefined/null
    if (f.sensitive) {
      sensitiveFields.push({
        key: f.key,
        value: f.value,
        type: 'secret',
        sensitive: true,
      });
    } else {
      // Store non-sensitive fields in meta for searchability
      meta[f.key] = f.value;
    }
  }

  return { meta, sensitiveFields };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export interface DuplicateMatch {
  index: number;
  existingId: string;
  existingName: string;
  matchType: 'exact' | 'name-only';
}

/**
 * Check imported credentials against existing agent credentials for duplicates.
 * Returns a map of import index → duplicate match info.
 */
export function detectDuplicates(
  imported: ImportedCredential[],
  agentId: string
): Map<number, DuplicateMatch> {
  const existing = listCredentials({ agentId });
  const duplicates = new Map<number, DuplicateMatch>();

  // Build lookup maps from existing credentials
  const existingByNameAndUrl = new Map<string, { id: string; name: string }>();
  const existingByName = new Map<string, { id: string; name: string }>();

  for (const cred of existing) {
    const name = cred.name.trim().toLowerCase();
    const url = normalizeUrl((cred.meta?.url as string) || '');
    const key = `${name}|${url}`;
    existingByNameAndUrl.set(key, { id: cred.id, name: cred.name });
    existingByName.set(name, { id: cred.id, name: cred.name });
  }

  for (let i = 0; i < imported.length; i++) {
    const cred = imported[i];
    const name = cred.name.trim().toLowerCase();
    const url = normalizeUrl(cred.url || '');

    // Check exact match (name + URL)
    const exactKey = `${name}|${url}`;
    const exactMatch = existingByNameAndUrl.get(exactKey);
    if (exactMatch && url) {
      duplicates.set(i, {
        index: i,
        existingId: exactMatch.id,
        existingName: exactMatch.name,
        matchType: 'exact',
      });
      continue;
    }

    // Check name-only match
    const nameMatch = existingByName.get(name);
    if (nameMatch) {
      duplicates.set(i, {
        index: i,
        existingId: nameMatch.id,
        existingName: nameMatch.name,
        matchType: 'name-only',
      });
    }
  }

  return duplicates;
}



function parseJsonObject(input: string): any {
  const cleaned = stripBOM(input).trim();
  if (!cleaned) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Invalid JSON payload');
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return parsed;
  throw new Error('Invalid JSON payload');
}

function coerceItems(root: any, keys: string[]): any[] {
  if (Array.isArray(root)) return root;
  for (const key of keys) {
    if (Array.isArray(root?.[key])) return root[key];
  }
  return [];
}

// ---------------------------------------------------------------------------
// 1Password CSV Parser
// ---------------------------------------------------------------------------

/**
 * Parse 1Password CSV export.
 * Expected columns: Title, URL, Username, Password, Notes, Type, OTP
 */
export function parse1PasswordCSV(csv: string): ImportedCredential[] {
  const cleaned = stripBOM(csv);
  const records = parse(cleaned, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  return records.map((row) => {
    // Map 1Password types to AuraMaxx types
    let type: CredentialType = 'login';
    const rawType = (row.Type || '').toLowerCase();
    if (rawType.includes('card') || rawType.includes('credit')) type = 'card';
    else if (rawType.includes('note')) type = 'note';
    else if (rawType.includes('api')) type = 'api';
    else if (rawType.includes('identity')) type = 'custom';

    const fields: ImportedField[] = [];

    if (row.Username) {
      fields.push({ key: 'username', value: row.Username, sensitive: fieldSensitive(type, 'username') });
    }
    if (row.Password) {
      fields.push({ key: 'password', value: row.Password, sensitive: fieldSensitive(type, 'password') });
    }
    if (row.Notes) {
      fields.push({ key: 'notes', value: row.Notes, sensitive: fieldSensitive(type, 'notes') });
    }
    if (row.OTP) {
      fields.push({ key: 'totp', value: row.OTP, sensitive: fieldSensitive(type, 'totp') });
    }

    return {
      name: row.Title || 'Untitled',
      type,
      url: row.URL || undefined,
      fields,
    };
  });
}

// ---------------------------------------------------------------------------
// Bitwarden CSV Parser
// ---------------------------------------------------------------------------

/**
 * Parse Bitwarden CSV export.
 * Expected columns: folder, favorite, type, name, notes, fields, reprompt,
 *   login_uri, login_username, login_password, login_totp
 */
export function parseBitwardenCSV(csv: string): ImportedCredential[] {
  const cleaned = stripBOM(csv);
  const records = parse(cleaned, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  return records.map((row) => {
    let type: CredentialType = 'login';
    const rawType = (row.type || '').toLowerCase();
    if (rawType === 'card') type = 'card';
    else if (rawType === 'securenote' || rawType === 'note') type = 'note';
    else if (rawType === 'identity') type = 'custom';

    const fields: ImportedField[] = [];

    if (row.login_username) {
      fields.push({ key: 'username', value: row.login_username, sensitive: fieldSensitive(type, 'username') });
    }
    if (row.login_password) {
      fields.push({ key: 'password', value: row.login_password, sensitive: fieldSensitive(type, 'password') });
    }
    if (row.notes) {
      fields.push({ key: 'notes', value: row.notes, sensitive: fieldSensitive(type, 'notes') });
    }
    if (row.login_totp) {
      fields.push({ key: 'totp', value: row.login_totp, sensitive: fieldSensitive(type, 'totp') });
    }

    const tags: string[] = [];
    if (row.folder) tags.push(row.folder);

    return {
      name: row.name || 'Untitled',
      type,
      url: row.login_uri || undefined,
      fields,
      tags: tags.length > 0 ? tags : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Chrome CSV Parser
// ---------------------------------------------------------------------------

/**
 * Parse Chrome password CSV export.
 * Expected columns: name, url, username, password, note
 */
export function parseChromeCSV(csv: string): ImportedCredential[] {
  const cleaned = stripBOM(csv);
  const records = parse(cleaned, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  return records.map((row) => {
    const fields: ImportedField[] = [];

    if (row.username) {
      fields.push({ key: 'username', value: row.username, sensitive: fieldSensitive('login', 'username') });
    }
    if (row.password) {
      fields.push({ key: 'password', value: row.password, sensitive: fieldSensitive('login', 'password') });
    }
    if (row.note) {
      fields.push({ key: 'notes', value: row.note, sensitive: fieldSensitive('login', 'notes') });
    }

    return {
      name: row.name || 'Untitled',
      type: 'login' as CredentialType,
      url: row.url || undefined,
      fields,
    };
  });
}

// ---------------------------------------------------------------------------
// Firefox CSV Parser
// ---------------------------------------------------------------------------

/**
 * Parse Firefox password CSV export.
 * Expected columns: url, username, password, httpRealm, formActionOrigin,
 *   guid, timeCreated, timeLastUsed, timePasswordChanged
 */
export function parseFirefoxCSV(csv: string): ImportedCredential[] {
  const cleaned = stripBOM(csv);
  const records = parse(cleaned, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  return records.map((row) => {
    const fields: ImportedField[] = [];

    if (row.username) {
      fields.push({ key: 'username', value: row.username, sensitive: fieldSensitive('login', 'username') });
    }
    if (row.password) {
      fields.push({ key: 'password', value: row.password, sensitive: fieldSensitive('login', 'password') });
    }

    // Derive a name from the URL
    let name = 'Untitled';
    if (row.url) {
      try {
        name = new URL(row.url).hostname.replace(/^www\./, '');
      } catch {
        name = row.url;
      }
    }

    return {
      name,
      type: 'login' as CredentialType,
      url: row.url || undefined,
      fields,
    };
  });
}

// ---------------------------------------------------------------------------
// iCloud Keychain CSV Parser
// ---------------------------------------------------------------------------

/**
 * Parse iCloud Keychain / Apple Passwords CSV export.
 * Common columns include:
 *   Title, URL, Username, Password, Notes, OTPAuth
 */
export function parseICloudCSV(csv: string): ImportedCredential[] {
  const records = parseCsvRows(csv);

  return records.map((row) => {
    const title = getRowValue(row, ['Title', 'Name', 'Site', 'Website']);
    const url = getRowValue(row, ['URL', 'Website', 'Site URL', 'Site']);
    const username = getRowValue(row, ['Username', 'User Name', 'Account', 'Login']);
    const password = getRowValue(row, ['Password', 'Passcode']);
    const notes = getRowValue(row, ['Notes', 'Note', 'Comments']);
    const totp = getRowValue(row, ['OTPAuth', 'TOTP', 'One-Time Code', 'One-Time Password']);

    const fields: ImportedField[] = [];
    if (username) fields.push({ key: 'username', value: username, sensitive: fieldSensitive('login', 'username') });
    if (password) fields.push({ key: 'password', value: password, sensitive: fieldSensitive('login', 'password') });
    if (notes) fields.push({ key: 'notes', value: notes, sensitive: fieldSensitive('login', 'notes') });
    if (totp) fields.push({ key: 'totp', value: totp, sensitive: fieldSensitive('login', 'totp') });

    let name = title || 'Untitled';
    if (!title && url) {
      try {
        name = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        name = url;
      }
    }

    return {
      name,
      type: 'login' as CredentialType,
      url: url || undefined,
      fields,
    };
  });
}

// ---------------------------------------------------------------------------
// LastPass CSV Parser
// ---------------------------------------------------------------------------

/**
 * Parse LastPass CSV export.
 * Common columns include:
 *   url, username, password, totp, extra, name, grouping, fav
 */
export function parseLastPassCSV(csv: string): ImportedCredential[] {
  const records = parseCsvRows(csv);

  return records.map((row) => {
    const nameFromRow = getRowValue(row, ['name', 'title']);
    const url = getRowValue(row, ['url', 'uri', 'website']);
    const username = getRowValue(row, ['username', 'user name', 'login']);
    const password = getRowValue(row, ['password', 'passcode']);
    const notes = getRowValue(row, ['extra', 'notes', 'note']);
    const totp = getRowValue(row, ['totp', 'otp']);
    const grouping = getRowValue(row, ['grouping', 'group', 'folder']);

    const fields: ImportedField[] = [];
    if (username) fields.push({ key: 'username', value: username, sensitive: fieldSensitive('login', 'username') });
    if (password) fields.push({ key: 'password', value: password, sensitive: fieldSensitive('login', 'password') });
    if (notes) fields.push({ key: 'notes', value: notes, sensitive: fieldSensitive('login', 'notes') });
    if (totp) fields.push({ key: 'totp', value: totp, sensitive: fieldSensitive('login', 'totp') });

    let name = nameFromRow || 'Untitled';
    if (!nameFromRow && url) {
      try {
        name = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        name = url;
      }
    }

    const tags = grouping ? [grouping] : undefined;

    return {
      name,
      type: 'login' as CredentialType,
      url: url || undefined,
      fields,
      tags,
    };
  });
}

// ---------------------------------------------------------------------------
// JSON Parsers
// ---------------------------------------------------------------------------

export function parse1PasswordJSON(json: string): ImportedCredential[] {
  const root = parseJsonObject(json);
  const items = coerceItems(root, ['items']);

  return items.map((item: any) => {
    const login = item?.login ?? {};
    const fields: ImportedField[] = [];

    if (login.username) fields.push({ key: 'username', value: String(login.username), sensitive: fieldSensitive('login', 'username') });
    if (login.password) fields.push({ key: 'password', value: String(login.password), sensitive: fieldSensitive('login', 'password') });
    if (item?.notesPlain || item?.notes) fields.push({ key: 'notes', value: String(item.notesPlain || item.notes), sensitive: fieldSensitive('login', 'notes') });

    const url = login?.urls?.[0]?.href || login?.uris?.[0]?.uri || login?.uris?.[0]?.url || item?.url || undefined;
    return {
      name: String(item?.title || item?.name || 'Untitled'),
      type: 'login' as CredentialType,
      url,
      fields,
    };
  });
}

export function parseBitwardenJSON(json: string): ImportedCredential[] {
  const root = parseJsonObject(json);
  const items = coerceItems(root, ['items']);

  return items.map((item: any) => {
    const login = item?.login ?? {};
    const fields: ImportedField[] = [];

    if (login.username) fields.push({ key: 'username', value: String(login.username), sensitive: fieldSensitive('login', 'username') });
    if (login.password) fields.push({ key: 'password', value: String(login.password), sensitive: fieldSensitive('login', 'password') });
    if (item?.notes) fields.push({ key: 'notes', value: String(item.notes), sensitive: fieldSensitive('login', 'notes') });
    if (login?.totp) fields.push({ key: 'totp', value: String(login.totp), sensitive: fieldSensitive('login', 'totp') });

    return {
      name: String(item?.name || 'Untitled'),
      type: 'login' as CredentialType,
      url: login?.uris?.[0]?.uri || undefined,
      fields,
    };
  });
}

export function parseChromeJSON(json: string): ImportedCredential[] {
  const root = parseJsonObject(json);
  const items = coerceItems(root, ['items', 'logins', 'passwords', 'credentials']);

  return items.map((item: any) => {
    const fields: ImportedField[] = [];
    if (item?.username) fields.push({ key: 'username', value: String(item.username), sensitive: fieldSensitive('login', 'username') });
    if (item?.password) fields.push({ key: 'password', value: String(item.password), sensitive: fieldSensitive('login', 'password') });
    if (item?.note || item?.notes) fields.push({ key: 'notes', value: String(item.note || item.notes), sensitive: fieldSensitive('login', 'notes') });

    return {
      name: String(item?.name || item?.title || 'Untitled'),
      type: 'login' as CredentialType,
      url: item?.url || item?.origin || item?.signon_realm || undefined,
      fields,
    };
  });
}

export function parseFirefoxJSON(json: string): ImportedCredential[] {
  const root = parseJsonObject(json);
  const items = coerceItems(root, ['logins', 'items', 'credentials']);

  return items.map((item: any) => {
    const fields: ImportedField[] = [];
    if (item?.username) fields.push({ key: 'username', value: String(item.username), sensitive: fieldSensitive('login', 'username') });
    if (item?.password) fields.push({ key: 'password', value: String(item.password), sensitive: fieldSensitive('login', 'password') });

    const url = item?.url || item?.hostname || undefined;
    let name = 'Untitled';
    if (url) {
      try {
        name = new URL(String(url)).hostname.replace(/^www\./, '');
      } catch {
        name = String(url);
      }
    }

    return {
      name,
      type: 'login' as CredentialType,
      url,
      fields,
    };
  });
}
