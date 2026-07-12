/**
 * App Installer
 * ================
 * Core logic for installing, removing, listing, and updating apps
 * from external sources (git repos, tarballs, zips, local paths).
 *
 * Used by both CLI (server/cli/commands/app.ts) and
 * dashboard API (src/app/api/apps/install/route.ts).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { parse as parseYaml } from 'yaml';
import { getErrorMessage } from './error';
import { getDefaultSync } from './defaults';

// ─── Types ──────────────────────────────────────────────────────────

export interface SourceInfo {
  type: 'git' | 'tarball' | 'zip' | 'local';
  url: string;
  ref: string | null;
  subdir: string | null;
  installedAt: string;
}

export interface InstalledApp {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  source: SourceInfo | null;
  path: string;
}

export interface InstallOptions {
  name?: string;
  force?: boolean;
}

export interface InstallResult {
  id: string;
  name: string;
  path: string;
  source: SourceInfo;
}

// ─── Constants ──────────────────────────────────────────────────────

function getMaxFileSize(): number {
  return getDefaultSync<number>('app.max_file_size_mb', 5) * 1024 * 1024;
}
function getMaxTotalSize(): number {
  return getDefaultSync<number>('app.max_total_size_mb', 20) * 1024 * 1024;
}

function appsDir(): string {
  return path.join(process.cwd(), 'apps');
}

// ─── Source Detection ───────────────────────────────────────────────

interface ParsedSource {
  type: 'git' | 'tarball' | 'zip' | 'local';
  url: string;
  subdir: string | null;
}

function parseSource(source: string): ParsedSource {
  let subdir: string | null = null;

  // Extract #path=subdir fragment
  const hashIdx = source.indexOf('#path=');
  let cleanSource = source;
  if (hashIdx !== -1) {
    subdir = source.slice(hashIdx + 6);
    cleanSource = source.slice(0, hashIdx);
  }

  // Local path
  if (cleanSource.startsWith('.') || path.isAbsolute(cleanSource)) {
    return { type: 'local', url: cleanSource, subdir };
  }

  // Tarball
  if (cleanSource.endsWith('.tar.gz') || cleanSource.endsWith('.tgz')) {
    return { type: 'tarball', url: cleanSource, subdir };
  }

  // Zip
  if (cleanSource.endsWith('.zip')) {
    return { type: 'zip', url: cleanSource, subdir };
  }

  // Git (github shorthand or URL)
  let gitUrl = cleanSource;
  if (gitUrl.startsWith('git@') || gitUrl.startsWith('ext::')) {
    throw new Error('Only HTTPS git URLs are allowed. git@ and ext:: transports are rejected for security.');
  }
  if (!gitUrl.startsWith('http://') && !gitUrl.startsWith('https://')) {
    gitUrl = `https://${gitUrl}`;
  }
  // Ensure .git suffix for HTTPS URLs
  if (gitUrl.startsWith('https://') && !gitUrl.endsWith('.git')) {
    gitUrl = `${gitUrl}.git`;
  }

  return { type: 'git', url: gitUrl, subdir };
}

// ─── Validation ─────────────────────────────────────────────────────

function validateApp(dir: string): { name: string; description: string; permissions: string[] } {
  const appMdPath = path.join(dir, 'app.md');

  if (!fs.existsSync(appMdPath)) {
    throw new Error('Missing app.md manifest');
  }

  // Parse YAML frontmatter
  const raw = fs.readFileSync(appMdPath, 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error('app.md missing YAML frontmatter (--- delimiters)');
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = parseYaml(match[1]);
  } catch {
    throw new Error('app.md has invalid YAML frontmatter');
  }

  if (!manifest) {
    throw new Error('app.md has empty YAML frontmatter');
  }

  // Extract description from body
  const parts = raw.split('---');
  const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : '';
  const description = body.split('\n\n')[0].replace(/^#+\s*/, '').trim();

  return {
    name: (manifest.name as string) || '',
    description,
    permissions: (manifest.permissions as string[]) || [],
  };
}

function checkSizeAndSymlinks(dir: string): void {
  const maxFileSize = getMaxFileSize();
  const maxTotalSize = getMaxTotalSize();
  let totalSize = 0;

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      // Check for symlinks escaping the directory
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(fullPath);
        if (!resolved.startsWith(dir)) {
          throw new Error(`Symlink escapes app directory: ${entry.name}`);
        }
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        if (stat.size > maxFileSize) {
          throw new Error(`File too large (>${maxFileSize / (1024 * 1024)}MB): ${path.relative(dir, fullPath)}`);
        }
        totalSize += stat.size;
        if (totalSize > maxTotalSize) {
          throw new Error(`Total app size exceeds ${maxTotalSize / (1024 * 1024)}MB limit`);
        }
      }
    }
  }

  walk(dir);
}

// ─── Fetch to Temp Dir ──────────────────────────────────────────────

function fetchSource(parsed: ParsedSource, tmpDir: string): string {
  switch (parsed.type) {
    case 'local': {
      const absPath = path.resolve(parsed.url);
      if (!fs.existsSync(absPath)) {
        throw new Error(`Local path not found: ${absPath}`);
      }
      // Copy to temp dir
      copyDirSync(absPath, tmpDir);
      return tmpDir;
    }

    case 'git': {
      try {
        execFileSync('git', ['clone', '--depth', '1', parsed.url, tmpDir], {
          stdio: 'pipe',
          timeout: 60000,
        });
      } catch (err) {
        const msg = getErrorMessage(err);
        throw new Error(`git clone failed: ${msg}`);
      }
      // Remove .git directory
      const gitDir = path.join(tmpDir, '.git');
      if (fs.existsSync(gitDir)) {
        fs.rmSync(gitDir, { recursive: true, force: true });
      }
      return tmpDir;
    }

    case 'tarball': {
      const archivePath = path.join(tmpDir, 'archive.tar.gz');
      downloadFile(parsed.url, archivePath);
      const extractDir = path.join(tmpDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      try {
        execFileSync('tar', ['xzf', archivePath, '-C', extractDir], {
          stdio: 'pipe',
          timeout: 30000,
        });
      } catch {
        throw new Error('Failed to extract tarball');
      }
      // If tarball contained a single directory, use that
      return findAppRoot(extractDir);
    }

    case 'zip': {
      const archivePath = path.join(tmpDir, 'archive.zip');
      downloadFile(parsed.url, archivePath);
      const extractDir = path.join(tmpDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      try {
        execFileSync('unzip', ['-o', archivePath, '-d', extractDir], {
          stdio: 'pipe',
          timeout: 30000,
        });
      } catch {
        throw new Error('Failed to extract zip');
      }
      return findAppRoot(extractDir);
    }
  }
}

/** If extracted archive has a single subdirectory, use that as root */
function findAppRoot(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory());

  // If there's a single directory and no app.md at root level, descend
  if (dirs.length === 1 && !fs.existsSync(path.join(dir, 'app.md'))) {
    return path.join(dir, dirs[0].name);
  }
  return dir;
}

function downloadFile(url: string, dest: string): void {
  // Use curl for downloading — universally available, restricted to HTTPS
  try {
    execFileSync('curl', ['-fsSL', '--proto', '=https', '-o', dest, url], {
      stdio: 'pipe',
      timeout: 60000,
    });
  } catch {
    throw new Error(`Failed to download: ${url}`);
  }
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      // Preserve symlinks (checkSizeAndSymlinks validates them later)
      const target = fs.readlinkSync(srcPath);
      fs.symlinkSync(target, destPath);
    } else if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Derive a app ID from the source URL/path */
function deriveAppId(parsed: ParsedSource): string {
  if (parsed.subdir) {
    return path.basename(parsed.subdir);
  }
  switch (parsed.type) {
    case 'local':
      return path.basename(path.resolve(parsed.url));
    case 'git': {
      // https://github.com/user/my-app.git → my-app
      const name = path.basename(parsed.url).replace(/\.git$/, '');
      return name || 'app';
    }
    case 'tarball': {
      // https://example.com/my-app.tar.gz → my-app
      return path.basename(parsed.url).replace(/\.(tar\.gz|tgz)$/, '') || 'app';
    }
    case 'zip': {
      return path.basename(parsed.url).replace(/\.zip$/, '') || 'app';
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Install a app from a source (git URL, tarball, zip, or local path).
 */
export function installApp(source: string, opts: InstallOptions = {}): InstallResult {
  const parsed = parseSource(source);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-app-'));

  try {
    // Fetch source to temp directory
    let appRoot = fetchSource(parsed, tmpDir);

    // Handle #path=subdir
    if (parsed.subdir) {
      const subPath = path.join(appRoot, parsed.subdir);
      if (!fs.existsSync(subPath)) {
        throw new Error(`Subdirectory not found: ${parsed.subdir}`);
      }
      appRoot = subPath;
    }

    // Validate the app
    const manifest = validateApp(appRoot);
    checkSizeAndSymlinks(appRoot);

    // Determine app ID
    const appId = opts.name || deriveAppId(parsed);
    if (!appId || appId === '.' || appId === '..') {
      throw new Error('Could not determine app ID. Use --name to specify one.');
    }

    // Check for conflicts
    const targetDir = path.join(appsDir(), appId);
    if (fs.existsSync(targetDir)) {
      if (!opts.force) {
        throw new Error(`App "${appId}" already exists. Use --force to overwrite.`);
      }
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    // Ensure apps/ directory exists
    fs.mkdirSync(appsDir(), { recursive: true });

    // Copy to final location
    copyDirSync(appRoot, targetDir);

    // Write .source.json for provenance
    const sourceInfo: SourceInfo = {
      type: parsed.type,
      url: parsed.type === 'local' ? path.resolve(parsed.url) : parsed.url,
      ref: null,
      subdir: parsed.subdir,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(targetDir, '.source.json'),
      JSON.stringify(sourceInfo, null, 2) + '\n',
    );

    return {
      id: appId,
      name: manifest.name || appId,
      path: targetDir,
      source: sourceInfo,
    };
  } finally {
    // Cleanup temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Remove an installed app by ID.
 */
export function removeApp(id: string): void {
  const targetDir = path.join(appsDir(), id);

  if (!fs.existsSync(targetDir)) {
    throw new Error(`App "${id}" not found`);
  }

  // Safety check: must have app.md
  if (!fs.existsSync(path.join(targetDir, 'app.md'))) {
    throw new Error(`"${id}" does not appear to be a app (no app.md)`);
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
}

/**
 * List all installed apps with source info.
 */
export function listApps(): InstalledApp[] {
  const dir = appsDir();
  if (!fs.existsSync(dir)) return [];

  const apps: InstalledApp[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const appDir = path.join(dir, entry.name);
    const mdPath = path.join(appDir, 'app.md');
    if (!fs.existsSync(mdPath)) continue;

    // Read manifest
    let name = entry.name;
    let description = '';
    let permissions: string[] = [];
    try {
      const raw = fs.readFileSync(mdPath, 'utf-8');
      const match = raw.match(/^---\n([\s\S]*?)\n---/);
      if (match) {
        const manifest = parseYaml(match[1]);
        if (manifest) {
          name = (manifest.name as string) || entry.name;
          permissions = (manifest.permissions as string[]) || [];
        }
      }
      const parts = raw.split('---');
      if (parts.length >= 3) {
        const body = parts.slice(2).join('---').trim();
        description = body.split('\n\n')[0].replace(/^#+\s*/, '').trim();
      }
    } catch {
      // Use defaults
    }

    // Read .source.json if it exists
    let source: SourceInfo | null = null;
    const sourcePath = path.join(appDir, '.source.json');
    if (fs.existsSync(sourcePath)) {
      try {
        source = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
      } catch {
        // Ignore parse errors
      }
    }

    apps.push({
      id: entry.name,
      name,
      description,
      permissions,
      source,
      path: appDir,
    });
  }

  return apps;
}

/**
 * Update a app by re-installing from its original source.
 */
export function updateApp(id: string): InstallResult {
  const targetDir = path.join(appsDir(), id);
  const sourcePath = path.join(targetDir, '.source.json');

  if (!fs.existsSync(targetDir)) {
    throw new Error(`App "${id}" not found`);
  }

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`App "${id}" has no .source.json — cannot determine original source`);
  }

  let sourceInfo: SourceInfo;
  try {
    sourceInfo = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
  } catch {
    throw new Error(`App "${id}" has invalid .source.json`);
  }

  // Re-construct the source string
  let source = sourceInfo.url;
  if (sourceInfo.subdir) {
    source += `#path=${sourceInfo.subdir}`;
  }

  return installApp(source, { name: id, force: true });
}
