import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { parse as parseYaml } from 'yaml';

import { validateExternalUrl } from '../network';
import { orderSources, validateManifest } from './loader';
import type { StrategyManifest, SourceDef } from './types';

type StrategySourceType = 'git' | 'tarball' | 'zip' | 'local' | 'inline';

interface ParsedSource {
  type: 'git' | 'tarball' | 'zip' | 'local';
  url: string;
  subdir: string | null;
}

export interface StrategyInstallProvenance {
  sourceType: StrategySourceType;
  sourceUrl: string;
  ref: string | null;
  subdir: string | null;
  hash: string;
  signaturePresent: boolean;
  installedAt: string;
}

export interface PreparedThirdPartyStrategy {
  manifest: StrategyManifest;
  provenance: StrategyInstallProvenance;
}

function parseSource(source: string): ParsedSource {
  let subdir: string | null = null;
  const hashIdx = source.indexOf('#path=');
  let cleanSource = source;
  if (hashIdx !== -1) {
    subdir = source.slice(hashIdx + 6);
    cleanSource = source.slice(0, hashIdx);
  }

  if (cleanSource.startsWith('.') || path.isAbsolute(cleanSource)) {
    return { type: 'local', url: cleanSource, subdir };
  }

  if (cleanSource.endsWith('.tar.gz') || cleanSource.endsWith('.tgz')) {
    return { type: 'tarball', url: cleanSource, subdir };
  }

  if (cleanSource.endsWith('.zip')) {
    return { type: 'zip', url: cleanSource, subdir };
  }

  let gitUrl = cleanSource;
  if (gitUrl.startsWith('git@') || gitUrl.startsWith('ext::')) {
    throw new Error('Only HTTPS git URLs are allowed for strategy install');
  }
  if (!gitUrl.startsWith('http://') && !gitUrl.startsWith('https://')) {
    gitUrl = `https://${gitUrl}`;
  }
  if (gitUrl.startsWith('http://')) {
    throw new Error('Only HTTPS sources are allowed for strategy install');
  }
  if (!gitUrl.endsWith('.git')) {
    gitUrl = `${gitUrl}.git`;
  }

  return { type: 'git', url: gitUrl, subdir };
}

function hashContent(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      fs.symlinkSync(target, destPath);
    } else if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function downloadFile(url: string, dest: string): void {
  execFileSync('curl', ['-fsSL', '--proto', '=https', '-o', dest, url], {
    stdio: 'pipe',
    timeout: 60_000,
  });
}

function findArchiveRoot(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length === 1 && !fs.existsSync(path.join(dir, 'app.md'))) {
    return path.join(dir, dirs[0].name);
  }
  return dir;
}

function deriveAllowedHosts(explicit: string[] | undefined, sources: SourceDef[]): string[] {
  const hosts = new Set(explicit || []);
  for (const source of sources) {
    if (source.url.startsWith('/') || source.url.includes('${')) continue;
    try {
      hosts.add(new URL(source.url).hostname);
    } catch {
      // Ignore unparseable URLs here; validated elsewhere.
    }
  }
  return hosts.size > 0 ? Array.from(hosts) : [];
}

function resolveAllowedHosts(explicit: string[] | undefined, sources: SourceDef[]): string[] {
  const normalizedExplicit = Array.isArray(explicit)
    ? explicit.map((host) => host.trim()).filter((host) => host.length > 0)
    : undefined;
  if (normalizedExplicit && normalizedExplicit.length > 0) {
    return deriveAllowedHosts(normalizedExplicit, sources);
  }
  return deriveAllowedHosts(undefined, sources);
}

function parseAppMarkdownManifest(appRoot: string, strategyId: string): { manifest: StrategyManifest; signaturePresent: boolean } {
  const mdPath = path.join(appRoot, 'app.md');
  if (!fs.existsSync(mdPath)) {
    throw new Error('Source package missing app.md');
  }

  const raw = fs.readFileSync(mdPath, 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error('app.md missing YAML frontmatter');
  }

  const parsed = parseYaml(match[1]) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('app.md frontmatter is invalid');
  }

  const sources = (parsed.sources as SourceDef[]) || [];
  const manifest: StrategyManifest = {
    id: strategyId,
    name: (parsed.name as string) || strategyId,
    icon: parsed.icon as string | undefined,
    category: parsed.category as string | undefined,
    size: parsed.size as string | undefined,
    autoStart: parsed.autoStart === true,
    ticker: parsed.ticker as StrategyManifest['ticker'],
    jobs: parsed.jobs as StrategyManifest['jobs'],
    sources,
    keys: parsed.keys as StrategyManifest['keys'],
    hooks: (parsed.hooks as StrategyManifest['hooks']) || {},
    config: (parsed.config as StrategyManifest['config']) || {},
    permissions: (parsed.permissions as string[]) || [],
    limits: parsed.limits as StrategyManifest['limits'],
    allowedHosts: resolveAllowedHosts(parsed.allowedHosts as string[] | undefined, sources),
  };

  manifest.sources = orderSources(manifest.sources);

  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`Invalid strategy manifest: ${errors.join('; ')}`);
  }

  const signaturePresent = Boolean(parsed.signature)
    || fs.existsSync(path.join(appRoot, 'SIGNATURE'))
    || fs.existsSync(path.join(appRoot, 'app.md.sig'))
    || fs.existsSync(path.join(appRoot, 'manifest.sig'));

  return { manifest, signaturePresent };
}

async function fetchSourceToTemp(parsed: ParsedSource, tempDir: string): Promise<{ rootDir: string; ref: string | null }> {
  if (parsed.type === 'local') {
    const absPath = path.resolve(parsed.url);
    if (!fs.existsSync(absPath)) throw new Error(`Local path not found: ${absPath}`);
    copyDirSync(absPath, tempDir);
    return { rootDir: tempDir, ref: null };
  }

  if (parsed.type === 'git') {
    await validateExternalUrl(parsed.url);
    execFileSync('git', ['clone', '--depth', '1', parsed.url, tempDir], {
      stdio: 'pipe',
      timeout: 60_000,
    });
    const ref = execFileSync('git', ['-C', tempDir, 'rev-parse', 'HEAD'], {
      stdio: 'pipe',
      timeout: 10_000,
    }).toString().trim() || null;
    return { rootDir: tempDir, ref };
  }

  if (parsed.type === 'tarball') {
    const archivePath = path.join(tempDir, 'archive.tar.gz');
    await validateExternalUrl(parsed.url);
    downloadFile(parsed.url, archivePath);
    const extractDir = path.join(tempDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['xzf', archivePath, '-C', extractDir], {
      stdio: 'pipe',
      timeout: 30_000,
    });
    return { rootDir: findArchiveRoot(extractDir), ref: null };
  }

  const archivePath = path.join(tempDir, 'archive.zip');
  await validateExternalUrl(parsed.url);
  downloadFile(parsed.url, archivePath);
  const extractDir = path.join(tempDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync('unzip', ['-o', archivePath, '-d', extractDir], {
    stdio: 'pipe',
    timeout: 30_000,
  });
  return { rootDir: findArchiveRoot(extractDir), ref: null };
}

function applySubdir(rootDir: string, subdir: string | null): string {
  if (!subdir) return rootDir;
  const subPath = path.join(rootDir, subdir);
  if (!fs.existsSync(subPath)) {
    throw new Error(`Subdirectory not found: ${subdir}`);
  }
  return subPath;
}

export async function prepareThirdPartyStrategyFromSource(input: {
  source: string;
  strategyId: string;
  strategyName?: string;
}): Promise<PreparedThirdPartyStrategy> {
  const parsed = parseSource(input.source);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-strategy-'));

  try {
    const { rootDir, ref } = await fetchSourceToTemp(parsed, tempDir);
    const strategyRoot = applySubdir(rootDir, parsed.subdir);
    const { manifest, signaturePresent } = parseAppMarkdownManifest(strategyRoot, input.strategyId);
    if (input.strategyName && input.strategyName.trim()) {
      manifest.name = input.strategyName.trim();
    }

    const normalizedUrl = parsed.type === 'local' ? path.resolve(parsed.url) : parsed.url;
    const hash = hashContent(JSON.stringify(manifest));
    const provenance: StrategyInstallProvenance = {
      sourceType: parsed.type,
      sourceUrl: normalizedUrl,
      ref,
      subdir: parsed.subdir,
      hash,
      signaturePresent,
      installedAt: new Date().toISOString(),
    };

    return { manifest, provenance };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function prepareThirdPartyStrategyFromManifest(input: {
  manifest: StrategyManifest;
  strategyId: string;
  sourceLabel?: string;
}): PreparedThirdPartyStrategy {
  const manifest = {
    ...input.manifest,
    id: input.strategyId,
    name: input.manifest.name || input.strategyId,
    hooks: input.manifest.hooks || {},
    sources: orderSources(input.manifest.sources || []),
    config: input.manifest.config || {},
    permissions: input.manifest.permissions || [],
    allowedHosts: resolveAllowedHosts(input.manifest.allowedHosts, input.manifest.sources || []),
  } as StrategyManifest;

  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`Invalid strategy manifest: ${errors.join('; ')}`);
  }

  const hash = hashContent(JSON.stringify(manifest));
  const provenance: StrategyInstallProvenance = {
    sourceType: 'inline',
    sourceUrl: input.sourceLabel || 'inline-manifest',
    ref: null,
    subdir: null,
    hash,
    signaturePresent: false,
    installedAt: new Date().toISOString(),
  };

  return { manifest, provenance };
}
