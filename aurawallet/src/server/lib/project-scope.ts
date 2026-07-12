import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

export type ProjectScopeCode =
  | 'PROJECT_SCOPE_MISSING_AURA'
  | 'PROJECT_SCOPE_INVALID_AURA'
  | 'PROJECT_SCOPE_DENIED'
  | 'PROJECT_SCOPE_OVERRIDE_USED';

export type ProjectScopeMode = 'auto' | 'strict' | 'off';

export interface ScopeCandidate {
  id?: string;
  name: string;
  agentName: string | null;
}

export interface ScopeDecision {
  allowed: boolean;
  code: ProjectScopeCode | null;
  remediation: string;
  projectScopeMode: ProjectScopeMode;
  normalizedIdentity: { agentName: string | null; credentialName: string };
  projectRoot: string | null;
  auraFingerprint: string | null;
  allowedCandidates: ScopeCandidate[];
  overrideUsed?: boolean;
}

interface ParsedRef {
  agentName: string | null;
  credentialName: string;
}

function normalize(str: string): string {
  return str.trim().toLowerCase();
}

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function shouldEmitProjectScopeEvent(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env.AURA_PROJECT_SCOPE_DEBUG);
}

function parseReference(ref: string): ParsedRef {
  if (ref.startsWith('@')) {
    const parts = ref.slice(1).split('/');
    if (parts.length < 3 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid agent reference: ${ref}`);
    }
    return { agentName: parts[0], credentialName: parts[1] };
  }
  const parts = ref.split('/');
  if (parts.length < 2 || !parts[0]) {
    throw new Error(`Invalid reference: ${ref}`);
  }
  return { agentName: null, credentialName: parts[0] };
}

function parseAuraAllowlist(auraPath: string): ParsedRef[] {
  const content = fs.readFileSync(auraPath, 'utf-8');
  const refs: ParsedRef[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) throw new Error(`Invalid line: ${line}`);
    const ref = line.slice(idx + 1).trim();
    refs.push(parseReference(ref));
  }

  return refs;
}

function normalizeProjectScopeMode(raw: unknown): ProjectScopeMode {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'strict') return 'strict';
  if (value === 'auto') return 'auto';
  if (value === 'off') return 'off';
  return 'off';
}

function findNearestAura(startDir: string): string | null {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, '.aura');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveGitRoot(startDir: string): string | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

function resolveAuraPath(opts: { cwd: string; projectRootOverride?: string }): { projectRoot: string | null; auraPath: string | null } {
  const explicit = opts.projectRootOverride || process.env.AURA_PROJECT_ROOT;
  if (explicit) {
    const root = path.resolve(explicit);
    return { projectRoot: root, auraPath: path.join(root, '.aura') };
  }

  const gitRoot = resolveGitRoot(opts.cwd);
  if (gitRoot) {
    return { projectRoot: gitRoot, auraPath: path.join(gitRoot, '.aura') };
  }

  const nearestAura = findNearestAura(opts.cwd);
  if (nearestAura) {
    return { projectRoot: path.dirname(nearestAura), auraPath: nearestAura };
  }

  return { projectRoot: null, auraPath: null };
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function isAllowed(candidate: ScopeCandidate, refs: ParsedRef[]): boolean {
  const candName = normalize(candidate.name);
  const candAgent = candidate.agentName ? normalize(candidate.agentName) : null;
  return refs.some((ref) => {
    if (normalize(ref.credentialName) !== candName) return false;
    if (!ref.agentName) return true;
    return candAgent === normalize(ref.agentName);
  });
}

export function evaluateProjectScopeAccess(input: {
  surface: string;
  requested: { agentName: string | null; credentialName: string };
  candidates: ScopeCandidate[];
  actor?: string;
  cwd?: string;
  projectRootOverride?: string;
  projectScopeMode?: ProjectScopeMode;
}): ScopeDecision {
  const projectScopeMode = normalizeProjectScopeMode(input.projectScopeMode || process.env.AURA_PROJECT_SCOPE_MODE || 'off');
  const normalizedIdentity = {
    agentName: input.requested.agentName,
    credentialName: input.requested.credentialName,
  };
  const bypass = process.env.AURA_PROJECT_SCOPE_BYPASS === '1';

  if (bypass) {
    return {
      allowed: true,
      code: 'PROJECT_SCOPE_OVERRIDE_USED',
      remediation: 'Unset AURA_PROJECT_SCOPE_BYPASS to restore strict project scoping.',
      projectScopeMode,
      normalizedIdentity,
      projectRoot: null,
      auraFingerprint: null,
      allowedCandidates: input.candidates,
      overrideUsed: true,
    };
  }

  if (projectScopeMode === 'off') {
    return {
      allowed: true,
      code: null,
      remediation: '',
      projectScopeMode,
      normalizedIdentity,
      projectRoot: null,
      auraFingerprint: null,
      allowedCandidates: input.candidates,
    };
  }

  const cwd = input.cwd || process.cwd();
  const { projectRoot, auraPath } = resolveAuraPath({ cwd, projectRootOverride: input.projectRootOverride });
  const auraExists = Boolean(auraPath && fs.existsSync(auraPath));
  const auraIsFile = auraExists
    ? (() => {
        try {
          return fs.statSync(auraPath!).isFile();
        } catch {
          return false;
        }
      })()
    : false;

  const auraFilePath = auraExists && auraIsFile && auraPath ? auraPath : null;

  if (!auraFilePath) {
    if (projectScopeMode === 'auto') {
      return {
        allowed: true,
        code: null,
        remediation: '',
        projectScopeMode,
        normalizedIdentity,
        projectRoot,
        auraFingerprint: null,
        allowedCandidates: input.candidates,
      };
    }
    const auraWrongType = auraExists && !auraIsFile;
    return {
      allowed: false,
      code: auraWrongType ? 'PROJECT_SCOPE_INVALID_AURA' : 'PROJECT_SCOPE_MISSING_AURA',
      remediation: auraWrongType
        ? '.aura must be a file (not a directory). Use ENV=@agent/name/field or ENV=name/field lines.'
        : 'Add a .aura file in the project root (or set AURA_PROJECT_ROOT / --project-root).',
      projectScopeMode,
      normalizedIdentity,
      projectRoot,
      auraFingerprint: null,
      allowedCandidates: [],
    };
  }

  let refs: ParsedRef[];
  let auraFingerprint: string;
  try {
    const content = fs.readFileSync(auraFilePath, 'utf-8');
    auraFingerprint = fingerprint(content);
    refs = parseAuraAllowlist(auraFilePath);
  } catch {
    if (projectScopeMode === 'auto') {
      return {
        allowed: true,
        code: null,
        remediation: '',
        projectScopeMode,
        normalizedIdentity,
        projectRoot,
        auraFingerprint: null,
        allowedCandidates: input.candidates,
      };
    }
    return {
      allowed: false,
      code: 'PROJECT_SCOPE_INVALID_AURA',
      remediation: 'Fix .aura syntax (ENV=@agent/name/field or ENV=name/field) and retry.',
      projectScopeMode,
      normalizedIdentity,
      projectRoot,
      auraFingerprint: null,
      allowedCandidates: [],
    };
  }

  const allowedCandidates = input.candidates.filter((candidate) => isAllowed(candidate, refs));
  if (allowedCandidates.length === 0) {
    return {
      allowed: false,
      code: 'PROJECT_SCOPE_DENIED',
      remediation: `Add '${input.requested.credentialName}' to .aura (or use an allowed credential).`,
      projectScopeMode,
      normalizedIdentity,
      projectRoot,
      auraFingerprint,
      allowedCandidates: [],
    };
  }

  if (!input.requested.agentName && allowedCandidates.length > 1) {
    return {
      allowed: false,
      code: 'PROJECT_SCOPE_DENIED',
      remediation: `Credential '${input.requested.credentialName}' is mapped in multiple agents. Re-run with explicit --agent.`,
      projectScopeMode,
      normalizedIdentity,
      projectRoot,
      auraFingerprint,
      allowedCandidates: [],
    };
  }

  return {
    allowed: true,
    code: null,
    remediation: '',
    projectScopeMode,
    normalizedIdentity,
    projectRoot,
    auraFingerprint,
    allowedCandidates,
  };
}

export function emitProjectScopeEvent(input: {
  actor?: string;
  surface: string;
  requestedCredential: { agentName: string | null; credentialName: string };
  decision: ScopeDecision;
}): void {
  if (!shouldEmitProjectScopeEvent()) {
    return;
  }

  const event = {
    actor: input.actor || 'unknown',
    surface: input.surface,
    projectScopeMode: input.decision.projectScopeMode,
    projectRoot: input.decision.projectRoot,
    auraFingerprint: input.decision.auraFingerprint,
    requestedCredential: input.requestedCredential,
    code: input.decision.code,
    timestamp: new Date().toISOString(),
    overrideUsed: Boolean(input.decision.overrideUsed),
  };
  console.warn(`[project-scope] ${JSON.stringify(event)}`);
}
