import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';
import { renderMarkdownToHtml, slugify } from './markdown';

export { slugify };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

const HTTP_METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const DOCS_DIR = path.join(process.cwd(), 'docs');
const ROOT_README = path.join(process.cwd(), 'README.md');
const EXCLUDED_DOC_FILES = new Set<string>([]);
const ALWAYS_EXCLUDED_TOP_LEVEL_DIRS = new Set(['specs']);
const TRUTHY_ENV = new Set(['1', 'true', 'yes', 'on']);
const FALSY_ENV = new Set(['0', 'false', 'no', 'off']);

const parseBooleanEnv = (value: string | undefined): boolean | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (TRUTHY_ENV.has(normalized)) return true;
  if (FALSY_ENV.has(normalized)) return false;
  return null;
};

const DEPLOYMENT_ENV_KEYS = [
  'VERCEL_ENV',
  'NEXT_PUBLIC_VERCEL_ENV',
  'VERCEL_TARGET_ENV',
  'NETLIFY_CONTEXT',
  'CF_PAGES_ENVIRONMENT',
] as const;

const detectHostedPreviewFromUrl = (): boolean | null => {
  const currentHost = process.env.VERCEL_URL?.trim().toLowerCase();
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim().toLowerCase();
  if (!currentHost || !productionHost) return null;
  return currentHost !== productionHost;
};

const resolveDeploymentEnv = (): string | null => {
  for (const key of DEPLOYMENT_ENV_KEYS) {
    const value = process.env[key]?.trim().toLowerCase();
    if (value) return value;
  }
  return null;
};

const isProductionLikeDeployment = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod';
};

const shouldShowInternalDocs = (): boolean => {
  const explicit = parseBooleanEnv(process.env.NEXT_PUBLIC_SHOW_INTERNAL_DOCS);
  if (explicit !== null) return explicit;

  // In hosted environments, NODE_ENV is often "production" even for preview/staging.
  // Prefer deploy-tier env vars when available.
  const deploymentEnv = resolveDeploymentEnv();
  if (deploymentEnv) return !isProductionLikeDeployment(deploymentEnv);

  // Some out-of-folder preview deployments miss deploy-tier env vars.
  // If Vercel exposes current/prod hostnames, use that as a fallback signal.
  const hostedPreview = detectHostedPreviewFromUrl();
  if (hostedPreview !== null) return hostedPreview;

  return process.env.NODE_ENV !== 'production';
};

const SHOW_INTERNAL_DOCS = shouldShowInternalDocs();

/** README.md lives at repo root, not in docs/. Map it to a virtual entry. */
const README_ENTRY = 'README.md';
const README_SIDEBAR_TITLE = 'Getting Started';
const DOCS_ROUTE_ROOT = '/docs';
const EXTERNAL_LINK_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DOC_PATH_ALIASES: Record<string, string> = {
  'AGENT_SETUP.md': 'quickstart/AGENT_SETUP.md',
  'TROUBLESHOOTING.md': 'how-to-auramaxx/TROUBLESHOOTING.md',
  'external/HOW_TO_AURAMAXX/WORKING_WITH_SECRETS.md': 'how-to-auramaxx/WORKING_WITH_SECRETS.md',
  'external/share-secret.md': 'how-to-auramaxx/share-secret.md',
  'core-concepts/FEATURES.md': 'why-auramaxx/FEATURES.md',
  'security.md': 'why-auramaxx/security.md',
  'ARCHITECTURE.md': 'why-auramaxx/ARCHITECTURE.md',
  'AUTH.md': 'ai-agents-workflow/AUTH.md',
  'external/POLICY.md': 'ai-agents-workflow/POLICY.md',
  'credentials.md': 'ai-agents-workflow/credentials.md',
  'SKILLS.md': 'ai-agents-workflow/SKILLS.md',
  'MCP.md': 'ai-agents-workflow/MCP.md',
  'CLI.md': 'ai-agents-workflow/CLI.md',
  'API.md': 'ai-agents-workflow/API.md',
  'BEST-PRACTICES.md': 'ai-agents-workflow/BEST-PRACTICES.md',
  'ADAPTERS.md': 'legacy/ADAPTERS.md',
  'APPS.md': 'legacy/APPS.md',
  'DESKTOP_ELECTRON.md': 'legacy/DESKTOP_ELECTRON.md',
  'DEVELOPING-APPS.md': 'legacy/DEVELOPING-APPS.md',
  'PACKAGING_POLICY.md': 'legacy/PACKAGING_POLICY.md',
  'PERMISSION.md': 'legacy/PERMISSION.md',
  'PROTOCOL.md': 'legacy/PROTOCOL.md',
  'WORKSPACE.md': 'legacy/WORKSPACE.md',
  'agent-auth.md': 'legacy/agent-auth.md',
  'aura-file.md': 'legacy/aura-file.md',
  'external/HOW_TO_AURAMAXX/README.md': 'legacy/external/HOW_TO_AURAMAXX/README.md',
  'external/getting-started.md': 'legacy/external/getting-started.md',
  'external/overview.md': 'legacy/external/overview.md',
  'external/persona-paths.md': 'legacy/external/persona-paths.md',
  'external/why-aura.md': 'legacy/external/why-aura.md',
  'wallet/README.md': 'legacy/wallet/README.md',
  'wallet/STRATEGY.md': 'legacy/wallet/STRATEGY.md',
  'wallet/DEVELOPING-STRATEGIES.md': 'legacy/wallet/DEVELOPING-STRATEGIES.md',
  'wallet/AI.md': 'legacy/wallet/AI.md',
  'templates/RELEASE_NOTES_TEMPLATE.md': 'legacy/templates/RELEASE_NOTES_TEMPLATE.md',
  'specs/aura-open-protocol.md': 'legacy/specs/aura-open-protocol.md',
  'specs/aura-provider-plugin.md': 'legacy/specs/aura-provider-plugin.md',
  'specs/aura-registry-model.md': 'legacy/specs/aura-registry-model.md',
  'specs/task-256-create-edit-ui.md': 'legacy/specs/task-256-create-edit-ui.md',
};

export const README_DOC_FILENAME = README_ENTRY;

export interface DocFile {
  filename: string;
  title: string;
  summary: string;
}

export interface DocGroup {
  label: string;
  docs: DocFile[];
}

/**
 * Sidebar groupings for public docs. Internal docs are appended in dev only.
 * Public docs not listed here are intentionally hidden until explicitly categorized.
 */
const DOC_CATEGORIES: { label: string; filenames: string[] }[] = [
  { label: 'QUICKSTART', filenames: ['README.md', 'quickstart/AGENT_SETUP.md'] },
  {
    label: 'HOW TO AURAMAXX',
    filenames: [
      'how-to-auramaxx/WORKING_WITH_SECRETS.md',
      'how-to-auramaxx/share-secret.md',
      'how-to-auramaxx/TROUBLESHOOTING.md',
    ],
  },
  {
    label: 'WHY AURAMAXX',
    filenames: ['why-auramaxx/FEATURES.md', 'why-auramaxx/security.md', 'why-auramaxx/ARCHITECTURE.md'],
  },
  {
    label: 'AI AGENTS WORKFLOW',
    filenames: [
      'ai-agents-workflow/AUTH.md',
      'ai-agents-workflow/POLICY.md',
      'ai-agents-workflow/credentials.md',
      'ai-agents-workflow/SKILLS.md',
      'ai-agents-workflow/MCP.md',
      'ai-agents-workflow/CLI.md',
      'ai-agents-workflow/API.md',
      'ai-agents-workflow/BEST-PRACTICES.md',
    ],
  },
  /* { label: 'WALLET (LATER)', filenames: ['legacy/wallet/README.md', 'legacy/wallet/STRATEGY.md', 'legacy/wallet/DEVELOPING-STRATEGIES.md', 'legacy/wallet/AI.md'] }, */
];

const INTERNAL_DOC_CATEGORIES: { label: string; prefixes?: string[]; filenames?: string[] }[] = [
  {
    label: 'INTERNAL · DAILY USE',
    filenames: [
      'internal/INDEX.md',
      'internal/TLDR_READ_THIS_IF_YOU_ARE_NEW.md',
      'internal/README.md',
      'internal/ALL_TESTING.md',
      'internal/CD_PREDEPLOY_TLDR.md',
      'internal/LAUNCH_CHECKLIST.md',
    ],
  },
  {
    label: 'INTERNAL · TESTING & RELEASE',
    prefixes: ['internal/CD/', 'internal/jobs/'],
    filenames: ['internal/SANDBOX_TESTING.md', 'internal/LAUNCH_PLAN.md', 'internal/EXTENSION_TESTING.md'],
  },
  {
    label: 'INTERNAL LAUNCH V1',
    prefixes: ['internal/v1/'],
    filenames: ['internal/v1/README.md'],
  },
  {
    label: 'INTERNAL · NOT READY',
    prefixes: ['internal/not-ready/'],
    filenames: ['internal/not-ready/README.md'],
  },
  {
    label: 'INTERNAL · REFERENCE',
    filenames: ['internal/TASK_LIFECYCLE.md', 'internal/WALLET_CLI_PARITY_MATRIX.md', 'internal/EXTENSION_V1_HARDENING.md'],
  },
  {
    label: 'INTERNAL · STRATEGY / ARCHIVE',
    filenames: ['internal/VISION.md', 'internal/IDEA.md', 'internal/HUMAN_CENTRIC_IDEA.md'],
  },
];

export interface ApiEndpoint {
  method: HttpMethod;
  path: string;
  section: string;
  source: 'http-fence' | 'table' | 'inline';
  permission?: string;
  authentication?: string;
}

interface EndpointCandidate extends ApiEndpoint {
  lineIndex: number;
}

const stripMarkdown = (value: string) => value.replace(/[`*_]/g, '').trim();

const cleanPath = (value: string): string | null => {
  const normalized = value.trim().replace(/^`|`$/g, '').replace(/[),.;]+$/, '');
  if (!normalized.startsWith('/')) return null;
  return normalized;
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

const normalizeDocPath = (value: string): string =>
  path.posix.normalize(value.replace(/\\/g, '/').replace(/^\/+/, ''));

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const normalizeRequestedDocFilename = (value: string): string => {
  let normalized = normalizeDocPath(safeDecodeURIComponent(value).replace(/^\.?\//, ''));
  if (normalized === '.' || !normalized) return README_ENTRY;
  while (normalized.startsWith('../')) normalized = normalized.slice(3);
  if (normalized.toLowerCase().startsWith('docs/')) normalized = normalized.slice('docs/'.length);
  normalized = DOC_PATH_ALIASES[normalized] || normalized;
  return normalized || README_ENTRY;
};

export const parseDocFilenameFromRouteSegments = (segments: string[]): string =>
  normalizeRequestedDocFilename(segments.map((segment) => safeDecodeURIComponent(segment)).join('/'));

export const getDocsHref = (filename: string): string => {
  const normalized = normalizeRequestedDocFilename(filename);
  if (normalized === README_ENTRY) return DOCS_ROUTE_ROOT;
  const encoded = normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${DOCS_ROUTE_ROOT}/${encoded}`;
};

const splitHrefSuffix = (href: string): { base: string; suffix: string } => {
  const hashIndex = href.indexOf('#');
  const queryIndex = href.indexOf('?');
  const splitIndex = hashIndex === -1
    ? queryIndex
    : queryIndex === -1
      ? hashIndex
      : Math.min(hashIndex, queryIndex);
  if (splitIndex === -1) return { base: href, suffix: '' };
  return { base: href.slice(0, splitIndex), suffix: href.slice(splitIndex) };
};

const resolveMarkdownDocTarget = (href: string, currentDocFilename: string): string | null => {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#')) return null;
  if (trimmed.startsWith('//')) return null;
  if (EXTERNAL_LINK_SCHEME.test(trimmed)) return null;

  const { base, suffix } = splitHrefSuffix(trimmed);
  if (!base.toLowerCase().endsWith('.md')) return null;

  let targetDoc: string | null = null;
  if (base.startsWith('/')) {
    const absolute = normalizeDocPath(base.slice(1));
    if (absolute === README_ENTRY) targetDoc = README_ENTRY;
    else if (absolute.toLowerCase().startsWith('docs/')) targetDoc = absolute.slice('docs/'.length);
    else if (absolute.toLowerCase().endsWith('.md') && !absolute.includes('/')) targetDoc = absolute;
  } else {
    const baseDir = currentDocFilename === README_ENTRY
      ? ''
      : path.posix.join('docs', path.posix.dirname(currentDocFilename));
    const resolved = normalizeDocPath(path.posix.join(baseDir, base));
    if (resolved === README_ENTRY) targetDoc = README_ENTRY;
    else if (resolved.toLowerCase().startsWith('docs/')) targetDoc = resolved.slice('docs/'.length);
    else if (currentDocFilename === README_ENTRY && resolved.toLowerCase().endsWith('.md') && !resolved.includes('/')) targetDoc = resolved;
  }

  if (!targetDoc) return null;
  return `${getDocsHref(targetDoc)}${suffix}`;
};

const isTopLevelDirExcluded = (topLevelDir?: string): boolean => {
  if (!topLevelDir) return false;
  if (ALWAYS_EXCLUDED_TOP_LEVEL_DIRS.has(topLevelDir)) return true;
  if (!SHOW_INTERNAL_DOCS && topLevelDir === 'internal') return true;
  return false;
};

const isExcludedDocPath = (docPath: string): boolean => {
  const normalized = normalizeDocPath(docPath);
  const [topLevel] = normalized.split('/');
  if (isTopLevelDirExcluded(topLevel)) return true;
  return false;
};

const collectPublicDocFiles = async (dirPath: string, prefix = ''): Promise<string[]> => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const collected: string[] = [];

  for (const entry of sorted) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!prefix && isTopLevelDirExcluded(entry.name)) continue;
      collected.push(...await collectPublicDocFiles(path.join(dirPath, entry.name), relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    if (isExcludedDocPath(relativePath)) continue;
    if (EXCLUDED_DOC_FILES.has(path.basename(relativePath))) continue;
    collected.push(relativePath);
  }

  return collected;
};

const parseEndpointMeta = (lines: string[], lineIndex: number): Pick<ApiEndpoint, 'permission' | 'authentication'> => {
  const lookahead = lines.slice(lineIndex + 1, lineIndex + 10).join('\n');
  const permissionMatch = lookahead.match(/Permission:\s*`([^`]+)`/i);
  const authenticationMatch = lookahead.match(/Authentication:\s*([^\n]+)/i);
  const publicMatch = lookahead.match(/no authentication required/i);

  return {
    permission: permissionMatch ? stripMarkdown(permissionMatch[1]) : undefined,
    authentication: publicMatch
      ? 'Public (no auth)'
      : authenticationMatch
        ? stripMarkdown(authenticationMatch[1])
        : undefined,
  };
};

const maybePushCandidate = (
  candidates: EndpointCandidate[],
  params: Omit<EndpointCandidate, 'permission' | 'authentication'>,
  lines: string[],
) => {
  const pathValue = cleanPath(params.path);
  if (!pathValue) return;
  if (!HTTP_METHODS.has(params.method)) return;
  const meta = parseEndpointMeta(lines, params.lineIndex);
  candidates.push({ ...params, path: pathValue, ...meta });
};

export const listDocFiles = async (): Promise<DocFile[]> => {
  const markdownFiles = (await collectPublicDocFiles(DOCS_DIR))
    // docs/README.md is an internal index doc and would collide with the virtual repo-root README entry.
    .filter((filename) => filename !== README_ENTRY)
    .sort((a, b) => {
      const order: Record<string, number> = { 'quickstart/AGENT_SETUP.md': 0 };
      const aPriority = order[a] ?? 999;
      const bPriority = order[b] ?? 999;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.localeCompare(b);
    });

  // Root README.md goes first as "Getting Started"
  const readmeContent = await fs.readFile(ROOT_README, 'utf8').catch(() => '');
  const readmeEntry: DocFile = {
    filename: README_ENTRY,
    title: README_SIDEBAR_TITLE,
    summary: readmeContent ? parseSummary(readmeContent) : 'Getting started with AuraMaxx.',
  };

  const docs = await Promise.all(
    markdownFiles.map(async (filename) => {
      const fullPath = path.join(DOCS_DIR, filename);
      const content = await fs.readFile(fullPath, 'utf8');
      return {
        filename,
        title: parseTitle(filename, content),
        summary: parseSummary(content),
      };
    }),
  );

  return [readmeEntry, ...docs];
};

export const listDocGroups = async (): Promise<DocGroup[]> => {
  const allDocs = await listDocFiles();
  const docMap = new Map(allDocs.map((doc) => [doc.filename, doc]));

  const groups: DocGroup[] = DOC_CATEGORIES.map(({ label, filenames }) => ({
    label,
    docs: filenames
      .filter((f) => docMap.has(f))
      .map((f) => docMap.get(f)!),
  })).filter((g) => g.docs.length > 0);

  if (SHOW_INTERNAL_DOCS) {
    const internalDocs = allDocs
      .filter((doc) => doc.filename.startsWith('internal/'))
      .sort((a, b) => a.filename.localeCompare(b.filename));

    if (internalDocs.length > 0) {
      const assigned = new Set<string>();

      for (const category of INTERNAL_DOC_CATEGORIES) {
        const docs = internalDocs.filter((doc) => {
          if (assigned.has(doc.filename)) return false;
          const exact = (category.filenames || []).includes(doc.filename);
          const prefix = (category.prefixes || []).some((p) => doc.filename.startsWith(p));
          return exact || prefix;
        });

        if (docs.length > 0) {
          docs.forEach((doc) => assigned.add(doc.filename));
          groups.push({ label: category.label, docs });
        }
      }

      const remaining = internalDocs.filter((doc) => !assigned.has(doc.filename));
      if (remaining.length > 0) {
        groups.push({ label: 'INTERNAL · OTHER (DEV ONLY)', docs: remaining });
      }
    }
  }

  return groups;
};

export const readDocFile = async (filename: string): Promise<string> => {
  const normalized = normalizeRequestedDocFilename(filename);
  if (!normalized.toLowerCase().endsWith('.md')) {
    throw new Error(`Invalid doc file: ${filename}`);
  }
  // Root README.md is served from repo root, not docs/
  if (normalized === README_ENTRY) {
    return fs.readFile(ROOT_README, 'utf8');
  }
  if (normalized.startsWith('../') || normalized === '..') {
    throw new Error('Path traversal attempt blocked');
  }
  if (isExcludedDocPath(normalized)) {
    throw new Error(`Doc is excluded from /docs: ${filename}`);
  }
  const fullPath = path.join(DOCS_DIR, normalized);
  if (!fullPath.startsWith(DOCS_DIR)) {
    throw new Error('Path traversal attempt blocked');
  }
  return fs.readFile(fullPath, 'utf8');
};

export const parseApiEndpoints = (content: string): ApiEndpoint[] => {
  const lines = content.split(/\r?\n/);
  let currentH2 = 'General';
  let currentH3 = '';
  let inCodeBlock = false;
  let codeFenceLang = '';
  const candidates: EndpointCandidate[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trim = line.trim();

    if (trim.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFenceLang = trim.slice(3).trim().toLowerCase();
      } else {
        inCodeBlock = false;
        codeFenceLang = '';
      }
      continue;
    }

    if (!inCodeBlock) {
      const h2Match = trim.match(/^##\s+(.+)$/);
      if (h2Match) {
        currentH2 = stripMarkdown(h2Match[1]);
        currentH3 = '';
        continue;
      }
      const h3Match = trim.match(/^###\s+(.+)$/);
      if (h3Match) {
        currentH3 = stripMarkdown(h3Match[1]);
        continue;
      }
    }

    const section = currentH3 ? `${currentH2} / ${currentH3}` : currentH2;

    if (inCodeBlock && ['', 'http', 'bash', 'sh', 'shell', 'text'].includes(codeFenceLang)) {
      const methodPath = trim.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(`?)(\/[^\s`]+)\2$/i);
      if (methodPath) {
        maybePushCandidate(
          candidates,
          {
            method: methodPath[1].toUpperCase() as HttpMethod,
            path: methodPath[3],
            section,
            source: 'http-fence',
            lineIndex: index,
          },
          lines,
        );
      }
    }

    if (!inCodeBlock && trim.startsWith('|')) {
      const columns = trim.split('|').map((value) => value.trim());
      if (columns.length >= 4) {
        const methodCell = columns[1].toUpperCase();
        const pathCell = columns[2];
        if (HTTP_METHODS.has(methodCell as HttpMethod)) {
          maybePushCandidate(
            candidates,
            {
              method: methodCell as HttpMethod,
              path: pathCell,
              section,
              source: 'table',
              lineIndex: index,
            },
            lines,
          );
        }
      }
    }

    if (!inCodeBlock) {
      for (const match of trim.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+`?(\/[A-Za-z0-9:._?=&/%\-]+)`?/gi)) {
        maybePushCandidate(
          candidates,
          {
            method: match[1].toUpperCase() as HttpMethod,
            path: match[2],
            section,
            source: 'inline',
            lineIndex: index,
          },
          lines,
        );
      }
    }
  }

  const deduped = new Map<string, ApiEndpoint>();
  for (const candidate of candidates) {
    const key = `${candidate.method} ${candidate.path}`;
    const existing = deduped.get(key);
    if (!existing) {
      const endpoint: ApiEndpoint = {
        method: candidate.method,
        path: candidate.path,
        section: candidate.section,
        source: candidate.source,
        permission: candidate.permission,
        authentication: candidate.authentication,
      };
      deduped.set(key, endpoint);
      continue;
    }
    if (!existing.permission && candidate.permission) existing.permission = candidate.permission;
    if (!existing.authentication && candidate.authentication) existing.authentication = candidate.authentication;
    if (existing.section === 'General' && candidate.section !== 'General') existing.section = candidate.section;
  }

  return [...deduped.values()].sort((a, b) => {
    const sectionCompare = a.section.localeCompare(b.section);
    if (sectionCompare !== 0) return sectionCompare;
    const pathCompare = a.path.localeCompare(b.path);
    if (pathCompare !== 0) return pathCompare;
    return a.method.localeCompare(b.method);
  });
};

interface RenderMarkdownOptions {
  currentDocFilename?: string;
}

export const renderMarkdown = (content: string, options: RenderMarkdownOptions = {}): string => {
  return renderMarkdownToHtml(content, {
    rewriteLinkHref: options.currentDocFilename
      ? (href: string) => resolveMarkdownDocTarget(href, options.currentDocFilename!)
      : undefined,
  });
};
