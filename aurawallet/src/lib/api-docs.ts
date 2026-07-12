import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';

const DOCS_DIR = path.join(process.cwd(), 'docs');
export const API_ENTRY_DOC = 'ai-agents-workflow/API.md';
const API_DOC_ALIASES: Record<string, string> = {
  'API.md': API_ENTRY_DOC,
};

interface ApiDocGroupConfig {
  label: string;
  collapsible?: boolean;
  filenames: string[];
}

const API_DOC_GROUP_CONFIG: ApiDocGroupConfig[] = [
  {
    label: 'GETTING STARTED',
    collapsible: false,
    filenames: [
      API_ENTRY_DOC,
      'api/authentication.md',
    ],
  },
  {
    label: 'SECRETS',
    filenames: [
      'api/secrets/credentials.md',
      'api/secrets/sharing.md',
      'api/secrets/api-keys.md',
    ],
  },
  {
    label: 'WALLETS',
    filenames: [
      'api/wallets/core.md',
      'api/wallets/data-portfolio.md',
      'api/wallets/apps-strategies.md',
    ],
  },
  {
    label: 'SYSTEM',
    filenames: [
      'api/system.md',
    ],
  },
];

const stripMarkdown = (value: string) => value.replace(/[`*_]/g, '').trim();

const normalizeDocPath = (value: string): string =>
  path.posix.normalize(value.replace(/\\/g, '/').replace(/^\/+/, ''));

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const parseSummary = (content: string): string => {
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('```')) continue;
    if (line.startsWith('|')) continue;
    if (line === '---') continue;
    return stripMarkdown(line);
  }
  return 'No summary available.';
};

const parseTitle = (filename: string, content: string): string => {
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) return stripMarkdown(headingMatch[1]);
  return path.basename(filename).replace(/\.md$/i, '').toUpperCase();
};

const API_DOC_FILENAMES = [...new Set(API_DOC_GROUP_CONFIG.flatMap((group) => group.filenames))];
const API_DOC_FILENAME_SET = new Set(API_DOC_FILENAMES);

export interface ApiDocFile {
  filename: string;
  title: string;
  summary: string;
}

export interface ApiDocGroup {
  label: string;
  collapsible: boolean;
  docs: ApiDocFile[];
}

const readApiDocMeta = async (filename: string): Promise<ApiDocFile> => {
  const content = await readApiDocFile(filename);
  return {
    filename,
    title: parseTitle(filename, content),
    summary: parseSummary(content),
  };
};

export const listApiDocGroups = async (): Promise<ApiDocGroup[]> => {
  const groups = await Promise.all(API_DOC_GROUP_CONFIG.map(async (group) => ({
    label: group.label,
    collapsible: group.collapsible ?? true,
    docs: await Promise.all(group.filenames.map((filename) => readApiDocMeta(filename))),
  })));

  return groups;
};

export const listApiDocFiles = async (): Promise<ApiDocFile[]> => {
  const groups = await listApiDocGroups();
  return groups.flatMap((group) => group.docs);
};

export const normalizeApiDocFilename = (value?: string | null): string => {
  const raw = (value || API_ENTRY_DOC).trim();
  let normalized = normalizeDocPath(safeDecodeURIComponent(raw).replace(/^\.\/?/, '').replace(/^docs\//i, ''));
  normalized = API_DOC_ALIASES[normalized] || normalized;
  if (!normalized || normalized === '.') return API_ENTRY_DOC;
  return normalized;
};

export const parseApiDocFilenameFromRouteSegments = (segments: string[]): string =>
  normalizeApiDocFilename((segments || []).map((segment) => safeDecodeURIComponent(segment)).join('/'));

export const getApiDocHref = (filename: string): string => {
  const normalized = normalizeApiDocFilename(filename);
  if (normalized === API_ENTRY_DOC) return '/api';
  const encoded = normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `/api/${encoded}`;
};

export const readApiDocFile = async (filename: string): Promise<string> => {
  const normalized = normalizeApiDocFilename(filename);
  if (!normalized.toLowerCase().endsWith('.md')) {
    throw new Error(`Invalid API doc file: ${filename}`);
  }
  if (!API_DOC_FILENAME_SET.has(normalized)) {
    throw new Error(`Unknown API doc file: ${filename}`);
  }
  if (normalized.startsWith('../') || normalized === '..') {
    throw new Error('Path traversal attempt blocked');
  }

  const fullPath = path.join(DOCS_DIR, normalized);
  if (!fullPath.startsWith(DOCS_DIR)) {
    throw new Error('Path traversal attempt blocked');
  }
  return fs.readFile(fullPath, 'utf8');
};
