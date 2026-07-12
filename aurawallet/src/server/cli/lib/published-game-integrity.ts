import { createHash, createPublicKey, verify } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

const PACKAGE_INTEGRITY_SCHEMA = 'aurajs.package-integrity.v1';
const PACKAGE_INTEGRITY_MANIFEST_PATH = 'aura.package-integrity.json';
const PACKAGE_INTEGRITY_SIGNATURE_PATH = 'aura.package-integrity.sig';
const PACKAGE_SIGNER_TRUST_STORE_PATH = 'published-game-signers.json';
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLAY_WRAPPER_REQUIRED_MARKERS = [
  '#!/usr/bin/env node',
  'const fallbackAuraPackage =',
  "const MINIMAL_COMMANDS = ['dev', 'join', 'play', 'fork', 'publish', 'session'];",
  "const ALL_COMMANDS = ['dev', 'join', 'play', 'fork', 'publish', 'session', 'state', 'inspect', 'action'];",
  "args: ['exec', '--yes', '--package', fallbackAuraPackage, '--', 'aura', ...commandArgs]",
] as const;

export class PublishedGameIntegrityError extends Error {
  reasonCode: string;
  details: Record<string, unknown>;

  constructor(reasonCode: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PublishedGameIntegrityError';
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function normalizeRelativePath(pathLike: string): string {
  return String(pathLike || '')
    .trim()
    .replace(/^[.][\\/]/, '')
    .replaceAll('\\', '/');
}

function normalizeText(value: string): string {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256Text(value: string): string {
  return sha256Buffer(Buffer.from(normalizeText(value), 'utf8'));
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new PublishedGameIntegrityError(
      'published_game_json_invalid',
      `Failed to parse JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { path },
    );
  }
}

function listRelativeFiles(root: string, current = root, acc: string[] = []): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      listRelativeFiles(root, fullPath, acc);
      continue;
    }
    if (entry.isFile()) {
      acc.push(normalizeRelativePath(relative(root, fullPath)));
    }
  }
  return acc;
}

function listHashedPackageFiles(root: string, current = root, acc: Array<{ path: string; size: number; sha256: string }> = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    const relativePath = normalizeRelativePath(relative(root, fullPath));

    if (relativePath === PACKAGE_INTEGRITY_MANIFEST_PATH || relativePath === PACKAGE_INTEGRITY_SIGNATURE_PATH) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new PublishedGameIntegrityError(
        'published_game_symlink_not_allowed',
        `Published game package may not contain symlinks: ${relativePath}`,
        { path: relativePath },
      );
    }
    if (entry.isDirectory()) {
      listHashedPackageFiles(root, fullPath, acc);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const bytes = readFileSync(fullPath);
    acc.push({
      path: relativePath,
      size: bytes.length,
      sha256: sha256Buffer(bytes),
    });
  }

  acc.sort((left, right) => left.path.localeCompare(right.path));
  return acc;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeysDeep(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function normalizeBinMap(projectPackage: Record<string, unknown>): Record<string, string> {
  if (typeof projectPackage?.bin === 'string' && projectPackage.bin.trim().length > 0) {
    return {
      [String(projectPackage?.name || 'game').split('/').pop() || 'game']: normalizeRelativePath(projectPackage.bin),
    };
  }

  const normalized: Record<string, string> = {};
  for (const key of Object.keys((projectPackage?.bin || {}) as Record<string, unknown>).sort()) {
    const value = (projectPackage.bin as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      continue;
    }
    normalized[key] = normalizeRelativePath(value);
  }
  return normalized;
}

function resolveProjectBinEntries(projectPackage: Record<string, unknown>, packageName: string | null) {
  const normalizedPackageName = normalizeString(packageName) || normalizeString(projectPackage?.name) || 'game';
  if (typeof projectPackage?.bin === 'string' && projectPackage.bin.trim().length > 0) {
    return [{
      name: normalizedPackageName.split('/').pop() || normalizedPackageName,
      relativePath: normalizeRelativePath(projectPackage.bin),
    }];
  }

  return Object.entries((projectPackage?.bin || {}) as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([name, value]) => ({
      name,
      relativePath: normalizeRelativePath(String(value)),
    }));
}

function assertPlayWrapperContract(relativePath: string, wrapperText: string): { markers: string[] } {
  const normalized = normalizeText(wrapperText);
  const missingMarkers = PLAY_WRAPPER_REQUIRED_MARKERS.filter((marker) => !normalized.includes(marker));
  if (missingMarkers.length > 0) {
    throw new PublishedGameIntegrityError(
      'published_game_bin_wrapper_contract_invalid',
      `Bin target "${relativePath}" does not satisfy the AuraJS play wrapper contract.`,
      {
        relativePath,
        missingMarkers,
      },
    );
  }

  return {
    markers: [...PLAY_WRAPPER_REQUIRED_MARKERS],
  };
}

function normalizeAuthoredMetadata(packageRoot: string) {
  const configPath = resolve(packageRoot, 'aura.config.json');
  if (!existsSync(configPath)) {
    return {
      identity: null,
      window: null,
    };
  }

  const config = readJsonFile(configPath);
  const iconPath = normalizeString((config.identity as Record<string, unknown> | undefined)?.icon);
  const normalizedIconPath = iconPath ? normalizeRelativePath(iconPath) : null;
  const iconAbsolutePath = normalizedIconPath ? resolve(packageRoot, normalizedIconPath) : null;
  const iconBytes = iconAbsolutePath && existsSync(iconAbsolutePath) && lstatSync(iconAbsolutePath).isFile()
    ? readFileSync(iconAbsolutePath)
    : null;

  return {
    identity: {
      name: normalizeString((config.identity as Record<string, unknown> | undefined)?.name),
      version: normalizeString((config.identity as Record<string, unknown> | undefined)?.version),
      executable: normalizeString((config.identity as Record<string, unknown> | undefined)?.executable),
      icon: normalizedIconPath,
      iconAsset: {
        path: normalizedIconPath,
        exists: Boolean(iconBytes),
        size: iconBytes ? iconBytes.length : null,
        sha256: iconBytes ? sha256Buffer(iconBytes) : null,
      },
    },
    window: {
      title: normalizeString((config.window as Record<string, unknown> | undefined)?.title),
    },
  };
}

function updateSignerTrustStore(trustRoot: string | null, packageName: string, packageVersion: string | null, signerFingerprint: string) {
  if (!trustRoot) {
    return {
      status: 'unchecked',
      storePath: null,
    };
  }

  const storePath = resolve(trustRoot, PACKAGE_SIGNER_TRUST_STORE_PATH);
  const existingEntries = existsSync(storePath) ? readJsonFile(storePath) : {};
  const existing = (existingEntries[packageName] as Record<string, unknown> | undefined) || null;
  const existingFingerprint = normalizeString(existing?.signerFingerprint);
  if (existingFingerprint && existingFingerprint !== signerFingerprint) {
    throw new PublishedGameIntegrityError(
      'published_game_signer_changed',
      `Published game signer changed for ${packageName}: expected ${existingFingerprint}, got ${signerFingerprint}.`,
      {
        packageName,
        packageVersion,
        expectedFingerprint: existingFingerprint,
        actualFingerprint: signerFingerprint,
        storePath,
      },
    );
  }

  const now = new Date().toISOString();
  const nextEntries = {
    ...existingEntries,
    [packageName]: {
      signerFingerprint,
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now,
      lastVersion: packageVersion,
    },
  };

  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(nextEntries, null, 2)}\n`, 'utf8');

  return {
    status: existing ? 'trusted' : 'trusted_first_use',
    storePath,
  };
}

export function buildPublishedGameLaunchEnv(
  source: NodeJS.ProcessEnv,
  explicit: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...(source || {}),
    ...explicit,
  };
}

export function assertPublishedGameBinIntegrity(input: {
  packageRoot: string;
  projectPackage?: Record<string, unknown> | null;
  packageName?: string | null;
  expectedAurajsVersion?: string | null;
}) {
  const packageRoot = resolve(input.packageRoot);
  const packageJsonPath = resolve(packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new PublishedGameIntegrityError(
      'published_game_package_json_missing',
      `Could not read installed package metadata at ${packageJsonPath}.`,
      { packageJsonPath },
    );
  }

  const projectPackage = input.projectPackage || readJsonFile(packageJsonPath);
  const packageName = normalizeString(input.packageName) || normalizeString(projectPackage?.name);
  const dependencySpec = normalizeString((projectPackage.dependencies as Record<string, unknown> | undefined)?.['@auraindustry/aurajs']);
  if (!dependencySpec) {
    throw new PublishedGameIntegrityError(
      'published_game_aurajs_dependency_missing',
      'Published AuraJS games must depend on @auraindustry/aurajs.',
      { packageJsonPath },
    );
  }
  if (!EXACT_SEMVER_PATTERN.test(dependencySpec)) {
    throw new PublishedGameIntegrityError(
      'published_game_aurajs_dependency_unpinned',
      'Published AuraJS games must pin @auraindustry/aurajs to an exact version.',
      { dependencySpec, packageJsonPath },
    );
  }
  if (normalizeString(input.expectedAurajsVersion) && dependencySpec !== input.expectedAurajsVersion) {
    throw new PublishedGameIntegrityError(
      'published_game_aurajs_dependency_version_mismatch',
      `Expected @auraindustry/aurajs version ${input.expectedAurajsVersion}, found ${dependencySpec}.`,
      {
        dependencySpec,
        expectedAurajsVersion: input.expectedAurajsVersion,
        packageJsonPath,
      },
    );
  }

  const binEntries = resolveProjectBinEntries(projectPackage, packageName);
  if (binEntries.length === 0) {
    throw new PublishedGameIntegrityError(
      'published_game_bin_missing',
      'Published AuraJS games must declare a generated wrapper entrypoint in package.json -> bin.',
      { packageJsonPath },
    );
  }

  for (const entry of binEntries) {
    if (!entry.relativePath.startsWith('bin/')) {
      throw new PublishedGameIntegrityError(
        'published_game_bin_path_outside_bin_dir',
        `Bin target "${entry.relativePath}" must live under bin/.`,
        { entry },
      );
    }
  }

  const binDir = resolve(packageRoot, 'bin');
  if (!existsSync(binDir)) {
    throw new PublishedGameIntegrityError(
      'published_game_bin_dir_missing',
      'Published AuraJS games must include a bin/ directory.',
      { binDir },
    );
  }

  const actualBinFiles = listRelativeFiles(binDir).map((entry) => normalizeRelativePath(join('bin', entry)));
  const declaredBinPaths = [...new Set(binEntries.map((entry) => entry.relativePath))];
  const declaredBinSet = new Set(declaredBinPaths);
  const unexpectedFiles = actualBinFiles.filter((entry) => !declaredBinSet.has(entry));
  if (unexpectedFiles.length > 0) {
    throw new PublishedGameIntegrityError(
      'published_game_bin_unexpected_file',
      `Published AuraJS games may not ship extra bin/ files: ${unexpectedFiles.join(', ')}`,
      {
        declaredBinPaths,
        unexpectedFiles,
      },
    );
  }

  const verifiedFiles = [];
  for (const relativePath of declaredBinPaths) {
    const absolutePath = resolve(packageRoot, relativePath);
    if (!existsSync(absolutePath)) {
      throw new PublishedGameIntegrityError(
        'published_game_bin_target_missing',
        `Published game bin target "${relativePath}" is missing from the installed package.`,
        { relativePath, absolutePath },
      );
    }

    const wrapperText = readFileSync(absolutePath, 'utf8');
    const contract = assertPlayWrapperContract(relativePath, wrapperText);

    verifiedFiles.push({
      relativePath,
      absolutePath,
      hash: sha256Text(wrapperText),
      contractMarkers: contract.markers,
    });
  }

  return {
    reasonCode: 'published_game_bin_integrity_ok',
    packageName,
    aurajsDependency: {
      spec: dependencySpec,
      wrapperContract: 'aurajs.play-wrapper.v1',
    },
    bin: {
      entries: binEntries,
      declaredFiles: declaredBinPaths,
      actualFiles: actualBinFiles,
      verifiedFiles,
    },
  };
}

export function verifyPublishedGamePackageIntegrity(input: {
  packageRoot: string;
  expectedPackageName?: string | null;
  trustRoot?: string | null;
}) {
  const packageRoot = resolve(input.packageRoot);
  const manifestPath = resolve(packageRoot, PACKAGE_INTEGRITY_MANIFEST_PATH);
  const signaturePath = resolve(packageRoot, PACKAGE_INTEGRITY_SIGNATURE_PATH);
  if (!existsSync(manifestPath) || !existsSync(signaturePath)) {
    throw new PublishedGameIntegrityError(
      'published_game_integrity_artifacts_missing',
      `Published game package must include ${PACKAGE_INTEGRITY_MANIFEST_PATH} and ${PACKAGE_INTEGRITY_SIGNATURE_PATH}.`,
      { manifestPath, signaturePath },
    );
  }

  const manifest = readJsonFile(manifestPath);
  const signature = String(readFileSync(signaturePath, 'utf8') || '').trim();
  if (normalizeString(manifest?.schema) !== PACKAGE_INTEGRITY_SCHEMA) {
    throw new PublishedGameIntegrityError(
      'published_game_integrity_schema_invalid',
      `Expected ${PACKAGE_INTEGRITY_SCHEMA}, found ${manifest?.schema || '<missing>'}.`,
      { schema: manifest?.schema || null },
    );
  }
  if (!signature) {
    throw new PublishedGameIntegrityError(
      'published_game_integrity_signature_missing',
      `${PACKAGE_INTEGRITY_SIGNATURE_PATH} is empty.`,
      { signaturePath },
    );
  }

  const publicKeyPem = normalizeString((manifest.signer as Record<string, unknown> | undefined)?.publicKeyPem);
  const signerFingerprint = normalizeString((manifest.signer as Record<string, unknown> | undefined)?.fingerprint);
  if (!publicKeyPem || !signerFingerprint) {
    throw new PublishedGameIntegrityError(
      'published_game_signer_missing',
      'Package integrity manifest is missing signer metadata.',
      {},
    );
  }

  const actualFingerprint = sha256Buffer(
    createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' }) as Buffer,
  );
  if (actualFingerprint !== signerFingerprint) {
    throw new PublishedGameIntegrityError(
      'published_game_signer_fingerprint_mismatch',
      'Package integrity signer fingerprint does not match the embedded public key.',
      {
        expectedFingerprint: signerFingerprint,
        actualFingerprint,
      },
    );
  }

  const signatureOk = verify(
    null,
    Buffer.from(stableSerialize(manifest)),
    publicKeyPem,
    Buffer.from(signature, 'base64'),
  );
  if (!signatureOk) {
    throw new PublishedGameIntegrityError(
      'published_game_integrity_signature_invalid',
      'Package integrity signature verification failed.',
      { signerFingerprint },
    );
  }

  if (normalizeString(input.expectedPackageName) && normalizeString((manifest.package as Record<string, unknown> | undefined)?.name) !== input.expectedPackageName) {
    throw new PublishedGameIntegrityError(
      'published_game_package_name_mismatch',
      `Expected published package ${input.expectedPackageName}, found ${(manifest.package as Record<string, unknown> | undefined)?.name || '<missing>'}.`,
      {
        expectedPackageName: input.expectedPackageName,
        actualPackageName: (manifest.package as Record<string, unknown> | undefined)?.name || null,
      },
    );
  }

  const actualFiles = listHashedPackageFiles(packageRoot);
  const expectedFiles = Array.isArray(manifest.files) ? manifest.files as Array<Record<string, unknown>> : [];
  const expectedByPath = new Map(expectedFiles.map((entry) => [normalizeRelativePath(String(entry.path || '')), entry]));
  const actualByPath = new Map(actualFiles.map((entry) => [entry.path, entry]));
  const missing = [];
  const mismatched = [];
  for (const [path, expected] of expectedByPath) {
    const actual = actualByPath.get(path);
    if (!actual) {
      missing.push(path);
      continue;
    }
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      mismatched.push({
        path,
        expected,
        actual,
      });
    }
  }
  const extra = actualFiles.filter((entry) => !expectedByPath.has(entry.path)).map((entry) => entry.path);
  if (missing.length > 0 || mismatched.length > 0 || extra.length > 0) {
    throw new PublishedGameIntegrityError(
      'published_game_file_mismatch',
      'Published game package contents do not match the signed integrity manifest.',
      {
        missing,
        extra,
        mismatched,
      },
    );
  }

  const packageJson = readJsonFile(resolve(packageRoot, 'package.json'));
  const actualPackageMetadata = {
    name: normalizeString(packageJson?.name),
    version: normalizeString(packageJson?.version),
    description: normalizeString(packageJson?.description),
    type: normalizeString(packageJson?.type),
    aurajsVersion: normalizeString((packageJson.dependencies as Record<string, unknown> | undefined)?.['@auraindustry/aurajs']),
    bin: normalizeBinMap(packageJson),
  };
  if (stableSerialize(actualPackageMetadata) !== stableSerialize(manifest.package || {})) {
    throw new PublishedGameIntegrityError(
      'published_game_package_metadata_mismatch',
      'Installed package.json metadata does not match the signed integrity manifest.',
      {
        expected: manifest.package || null,
        actual: actualPackageMetadata,
      },
    );
  }

  const actualAuthoredMetadata = normalizeAuthoredMetadata(packageRoot);
  if (stableSerialize(actualAuthoredMetadata) !== stableSerialize((manifest.publishedMetadata as Record<string, unknown> | undefined)?.authored || {})) {
    throw new PublishedGameIntegrityError(
      'published_game_authored_metadata_mismatch',
      'Installed authored game metadata does not match the signed integrity manifest.',
      {
        expected: (manifest.publishedMetadata as Record<string, unknown> | undefined)?.authored || null,
        actual: actualAuthoredMetadata,
      },
    );
  }

  const trust = updateSignerTrustStore(
    normalizeString(input.trustRoot),
    normalizeString(actualPackageMetadata.name) || '<unknown>',
    normalizeString(actualPackageMetadata.version),
    signerFingerprint,
  );

  return {
    reasonCode: 'published_game_package_integrity_ok',
    manifestPath,
    signaturePath,
    packageName: actualPackageMetadata.name,
    packageVersion: actualPackageMetadata.version,
    signerFingerprint,
    trust,
    fileCount: expectedFiles.length,
    publishedMetadata: manifest.publishedMetadata || null,
  };
}
