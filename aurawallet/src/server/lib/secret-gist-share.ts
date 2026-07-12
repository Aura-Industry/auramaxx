import { spawn } from 'child_process';
import {
  canonicalizeCredentialFieldKey,
  getCredentialPrimaryFieldKey,
} from '../../../shared/credential-field-schema';

export type SecretGistAccessMode = 'anyone' | 'password';
export type SecretGistErrorCode = 'GH_MISSING' | 'GH_AUTH_REQUIRED' | 'GH_CREATE_FAILED';

export interface SecretGistField {
  key: string;
  value: string;
  sensitive?: boolean;
}

export class SecretGistError extends Error {
  code: SecretGistErrorCode;
  remediation: string;
  detail?: string;

  constructor(
    code: SecretGistErrorCode,
    message: string,
    remediation: string,
    detail?: string,
  ) {
    super(message);
    this.name = 'SecretGistError';
    this.code = code;
    this.remediation = remediation;
    this.detail = detail;
  }
}

export interface SecretGistInput {
  credentialId: string;
  credentialName: string;
  credentialType?: string;
  shareUrl: string;
  accessMode: SecretGistAccessMode;
  oneTimeOnly: boolean;
  expiresAfter: string;
  fields?: SecretGistField[];
}

export interface SecretGistDraft {
  title: string;
  filename: string;
  marker: string;
  identifier: string;
  content: string;
}

export interface SecretGistResult extends SecretGistDraft {
  url: string;
}

interface GhCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnError: NodeJS.ErrnoException | null;
}

function normalizeInlineText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function normalizeFieldValue(raw: string): string {
  return raw.replace(/\r?\n/g, '\\n').trim();
}

function normalizeLookupKey(type: string | undefined, key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (!type) return trimmed.toLowerCase();
  return canonicalizeCredentialFieldKey(type, trimmed).toLowerCase();
}

function formatFieldLabel(raw: string): string {
  const trimmed = normalizeInlineText(raw);
  if (!trimmed) return 'FIELD';
  return trimmed.replace(/\s+/g, '_').toUpperCase();
}

function resolvePrimaryField(fields: SecretGistField[], type?: string): { index: number; value: string } {
  if (fields.length === 0) return { index: -1, value: '(none)' };

  if (type) {
    const mappedKey = normalizeLookupKey(type, getCredentialPrimaryFieldKey(type));
    if (mappedKey) {
      const mappedSensitiveIndex = fields.findIndex((field) =>
        normalizeLookupKey(type, field.key) === mappedKey && field.sensitive !== false);
      if (mappedSensitiveIndex >= 0) {
        return { index: mappedSensitiveIndex, value: fields[mappedSensitiveIndex].value };
      }
      const mappedIndex = fields.findIndex((field) => normalizeLookupKey(type, field.key) === mappedKey);
      if (mappedIndex >= 0) {
        return { index: mappedIndex, value: fields[mappedIndex].value };
      }
    }
  }

  const valueKeyIndex = fields.findIndex((field) => normalizeLookupKey(type, field.key) === 'value');
  if (valueKeyIndex >= 0) {
    return { index: valueKeyIndex, value: fields[valueKeyIndex].value };
  }

  const firstSensitiveIndex = fields.findIndex((field) => field.sensitive !== false);
  if (firstSensitiveIndex >= 0) {
    return { index: firstSensitiveIndex, value: fields[firstSensitiveIndex].value };
  }

  return { index: 0, value: fields[0].value };
}

function sanitizeFilenameSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function extractFirstUrl(raw: string): string | null {
  const match = raw.match(/https?:\/\/[^\s]+/i);
  if (!match) return null;
  return match[0].replace(/[)\],.]+$/, '');
}

function looksLikeAuthFailure(raw: string): boolean {
  const lower = raw.toLowerCase();
  return lower.includes('gh auth login')
    || lower.includes('not logged in')
    || lower.includes('authenticate')
    || lower.includes('authentication');
}

function missingGhError(): SecretGistError {
  return new SecretGistError(
    'GH_MISSING',
    'GitHub CLI (`gh`) is not installed. Secret gist sharing requires `gh`.',
    'Install GitHub CLI from https://cli.github.com/ and run `gh auth login`, then retry.',
  );
}

function unauthenticatedGhError(detail?: string): SecretGistError {
  return new SecretGistError(
    'GH_AUTH_REQUIRED',
    'GitHub CLI is not authenticated for gist creation.',
    'Run `gh auth login` (or `gh auth status`) and retry the share command.',
    detail,
  );
}

function gistCreateError(detail?: string): SecretGistError {
  return new SecretGistError(
    'GH_CREATE_FAILED',
    'Failed to create secret gist via GitHub CLI.',
    'Verify `gh auth status` succeeds and retry `gh gist create` (without `--public`).',
    detail,
  );
}

function runGh(args: string[], stdinText?: string): Promise<GhCommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: GhCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn('gh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        code: 127,
        stdout,
        stderr,
        spawnError: error,
      });
    });

    child.on('close', (code) => {
      finish({
        code: typeof code === 'number' ? code : 1,
        stdout,
        stderr,
        spawnError: null,
      });
    });

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

function isMissingGh(result: GhCommandResult): boolean {
  return result.spawnError?.code === 'ENOENT';
}

export function buildSecretGistDraft(input: SecretGistInput): SecretGistDraft {
  const normalizedName = normalizeInlineText(input.credentialName) || 'credential';
  const filenameSlug = sanitizeFilenameSlug(normalizedName) || 'credential';
  const title = 'AURAMAXX.SH';
  const filename = `auramaxx-sh-${filenameSlug}.txt`;
  const marker = '';
  const identifier = '';

  const normalizedFields = (input.fields || [])
    .map((field) => ({
      key: normalizeInlineText(field.key || 'field'),
      value: normalizeFieldValue(String(field.value || '')),
      sensitive: field.sensitive,
    }))
    .filter((field) => field.key.length > 0 && field.value.length > 0);

  const primary = resolvePrimaryField(normalizedFields, input.credentialType);
  const otherFields = normalizedFields.filter((_, index) => index !== primary.index);

  const lines = [
    '------------------------------',
    'AURAMAXX.SH',
    '------------------------------',
    `NAME: ${normalizedName}`,
    `VALUE: ${normalizeFieldValue(primary.value) || '(none)'}`,
    '',
  ];

  for (const field of otherFields) {
    lines.push(`${formatFieldLabel(field.key)}: ${field.value}`);
  }

  return {
    title,
    filename,
    marker,
    identifier,
    content: `${lines.join('\n')}\n`,
  };
}

export async function createSecretGist(input: SecretGistInput): Promise<SecretGistResult> {
  const authCheck = await runGh(['auth', 'status']);
  if (isMissingGh(authCheck)) {
    throw missingGhError();
  }
  if (authCheck.code !== 0) {
    const detail = normalizeInlineText(`${authCheck.stderr}\n${authCheck.stdout}`.trim());
    throw unauthenticatedGhError(detail || undefined);
  }

  const draft = buildSecretGistDraft(input);
  const createResult = await runGh(
    // `gh gist create` defaults to secret/private. Newer gh versions do not support `--private`.
    ['gist', 'create', '--filename', draft.filename, '--desc', draft.title, '-'],
    draft.content,
  );

  if (isMissingGh(createResult)) {
    throw missingGhError();
  }
  if (createResult.code !== 0) {
    const detail = normalizeInlineText(`${createResult.stderr}\n${createResult.stdout}`.trim());
    if (looksLikeAuthFailure(detail)) {
      throw unauthenticatedGhError(detail || undefined);
    }
    throw gistCreateError(detail || undefined);
  }

  const combinedOutput = `${createResult.stdout}\n${createResult.stderr}`;
  const url = extractFirstUrl(combinedOutput);
  if (!url) {
    throw gistCreateError('gh gist create succeeded but no gist URL was returned.');
  }

  return {
    ...draft,
    url,
  };
}
