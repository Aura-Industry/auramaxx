import { isIPv4, isIPv6 } from 'net';
import {
  AdvisoryFinding,
  API_AUDIT_EXIT_CODES,
  API_REGISTRY_ERROR_CODES,
  API_REGISTRY_IDENTITY_REGEX,
  API_REGISTRY_RESERVED_NAMESPACES,
  API_REGISTRY_RESERVED_PACKAGE_NAMES,
  LocalPolicy,
  PublisherKey,
  SignatureEnvelope,
  permissionSchema,
} from './contracts';

export class ApiRegistryValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiRegistryValidationError';
  }
}

export function validatePackageIdentity(identity: string): { namespace: string; name: string } {
  const match = identity.match(API_REGISTRY_IDENTITY_REGEX);
  if (!match) {
    throw new ApiRegistryValidationError(
      API_REGISTRY_ERROR_CODES.nameInvalid,
      `Invalid package identity "${identity}". Expected @namespace/name`
    );
  }

  const namespace = match[1];
  const name = match[2];

  if (API_REGISTRY_RESERVED_NAMESPACES.has(namespace) || API_REGISTRY_RESERVED_PACKAGE_NAMES.has(name)) {
    throw new ApiRegistryValidationError(
      API_REGISTRY_ERROR_CODES.nameInvalid,
      `Package identity "${identity}" uses a reserved namespace or package name`
    );
  }

  return { namespace, name };
}

function isFqdn(host: string): boolean {
  // strict enough for MVP: labels with lowercase letters/digits/hyphens, at least one dot
  if (!host.includes('.')) return false;
  if (host.includes('*') || host.includes('/') || host.includes('?') || host.includes(':')) return false;
  const labels = host.split('.');
  return labels.every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label));
}

export function validateAllowedHosts(allowedHosts: string[]): void {
  for (const host of allowedHosts) {
    if (!isFqdn(host) || isIPv4(host) || isIPv6(host)) {
      throw new ApiRegistryValidationError(
        API_REGISTRY_ERROR_CODES.egressDenied,
        `Host "${host}" is invalid. allowedHosts must contain FQDN values only`
      );
    }
  }
}

export function enforceEgressPolicy(hostname: string, allowedHosts: readonly string[]): void {
  if (!allowedHosts.includes(hostname)) {
    throw new ApiRegistryValidationError(
      API_REGISTRY_ERROR_CODES.egressDenied,
      `Blocked outbound host: ${hostname}`
    );
  }
}

export function validateSignatureEnvelope(envelope: SignatureEnvelope): void {
  if (envelope.algorithm !== 'ed25519') {
    throw new ApiRegistryValidationError(
      API_REGISTRY_ERROR_CODES.signatureAlgorithmUnsupported,
      `Unsupported signature algorithm: ${envelope.algorithm}`
    );
  }

  if (!envelope.keyId || !envelope.sig || !envelope.payloadHash || !envelope.createdAt) {
    throw new ApiRegistryValidationError(
      API_REGISTRY_ERROR_CODES.signatureAlgorithmUnsupported,
      'Signature envelope is missing required fields'
    );
  }
}

export function resolveEffectivePermissions(
  requiredPermissions: string[],
  localPolicy: LocalPolicy,
  runtimeHardDeny: Set<string>
): string[] {
  for (const permission of requiredPermissions) {
    const parsed = permissionSchema.safeParse(permission);
    if (!parsed.success) {
      throw new ApiRegistryValidationError(
        API_REGISTRY_ERROR_CODES.permissionUnresolved,
        `Required permission "${permission}" is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
      );
    }

    const deniedByRuntime = runtimeHardDeny.has(permission);
    const deniedByPolicy = (localPolicy.deny ?? []).includes(permission);
    const allowedByPolicy = (localPolicy.allow ?? []).includes(permission);

    if (deniedByRuntime || deniedByPolicy || !allowedByPolicy) {
      throw new ApiRegistryValidationError(
        API_REGISTRY_ERROR_CODES.permissionUnresolved,
        `Required permission "${permission}" could not be resolved under local/runtime policy`
      );
    }
  }

  return [...new Set(requiredPermissions)].sort();
}

export function enforceHistoricalKeyTrust(key: PublisherKey, signatureCreatedAt: string): void {
  const signatureTime = Date.parse(signatureCreatedAt);
  const keyCreatedAt = Date.parse(key.createdAt);

  if (Number.isNaN(signatureTime) || Number.isNaN(keyCreatedAt)) {
    throw new ApiRegistryValidationError(
      API_REGISTRY_ERROR_CODES.keyTrustInvalid,
      'Invalid timestamp in key trust evaluation'
    );
  }

  if (signatureTime < keyCreatedAt) {
    throw new ApiRegistryValidationError(
      API_REGISTRY_ERROR_CODES.keyTrustInvalid,
      'Signature predates key creation'
    );
  }

  if (key.status === 'compromised') {
    const cutoff = Date.parse(key.compromiseDetectedAt ?? '');
    if (Number.isNaN(cutoff) || signatureTime >= cutoff) {
      throw new ApiRegistryValidationError(
        API_REGISTRY_ERROR_CODES.keyTrustInvalid,
        'Signature is outside historical trust window for compromised key'
      );
    }
  }
}

export function evaluateAuditExitCode(input: {
  mode: 'ci' | 'local';
  yanked: boolean;
  integrityFailure: boolean;
  findings: AdvisoryFinding[];
}): number {
  if (input.integrityFailure) return API_AUDIT_EXIT_CODES.integrityFailure;
  if (input.yanked) return API_AUDIT_EXIT_CODES.yankedBlocked;

  const hasExploitKnown = input.findings.some((finding) => Boolean(finding.exploitKnown));
  const hasCritical = input.findings.some((finding) => finding.severity === 'critical');
  const hasHigh = input.findings.some((finding) => finding.severity === 'high');

  if (hasExploitKnown || hasCritical) {
    return API_AUDIT_EXIT_CODES.advisoryBlocked;
  }

  if (input.mode === 'ci' && hasHigh) {
    return API_AUDIT_EXIT_CODES.advisoryBlocked;
  }

  if (input.mode === 'local' && hasHigh) {
    return API_AUDIT_EXIT_CODES.warning;
  }

  return API_AUDIT_EXIT_CODES.ok;
}
