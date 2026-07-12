import { z } from 'zod';

export const API_REGISTRY_ERROR_CODES = {
  nameInvalid: 'E_NAME_INVALID',
  egressDenied: 'E_EGRESS_DENIED',
  signatureAlgorithmUnsupported: 'E_SIG_ALG_UNSUPPORTED',
  permissionUnresolved: 'E_PERMISSION_UNRESOLVED',
  keyTrustInvalid: 'E_KEY_TRUST_INVALID',
} as const;

export const API_REGISTRY_RESERVED_NAMESPACES = new Set([
  'aura',
  'registry',
  'security',
  'system',
  'admin',
  'root',
]);

export const API_REGISTRY_RESERVED_PACKAGE_NAMES = new Set([
  'internal',
  'private',
  'null',
  'undefined',
  'latest',
]);

export const API_REGISTRY_IDENTITY_REGEX =
  /^@([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/([a-z0-9][a-z0-9-]{1,62}[a-z0-9])$/;

export const API_REGISTRY_ALLOWED_PERMISSIONS = [
  'http.read',
  'http.write',
  'events.emit',
  'filesystem.read:workspace',
  'filesystem.write:workspace',
] as const;

const scopedPermissionPattern = /^(secrets\.(read|write):[a-z0-9][a-z0-9:_-]{0,63})$/;

export const permissionSchema = z
  .string()
  .refine((value) => API_REGISTRY_ALLOWED_PERMISSIONS.includes(value as (typeof API_REGISTRY_ALLOWED_PERMISSIONS)[number]) || scopedPermissionPattern.test(value), {
    message: 'Permission is outside of the MVP bounded permission catalog',
  })
  .refine((value) => !value.includes('*'), {
    message: 'Wildcard permissions are not permitted in MVP',
  });

export type KeyStatus = 'active' | 'retired' | 'compromised';

export interface PublisherKey {
  keyId: string;
  status: KeyStatus;
  createdAt: string;
  compromiseDetectedAt?: string;
}

export interface SignatureEnvelope {
  algorithm: string;
  keyId: string;
  sig: string;
  createdAt: string;
  payloadHash: string;
}

export interface LocalPolicy {
  allow?: string[];
  deny?: string[];
}

export const API_AUDIT_EXIT_CODES = {
  ok: 0,
  warning: 20,
  advisoryBlocked: 21,
  yankedBlocked: 22,
  integrityFailure: 23,
} as const;

export type AdvisorySeverity = 'low' | 'medium' | 'high' | 'critical';
export type AuditMode = 'ci' | 'local';

export interface AdvisoryFinding {
  severity: AdvisorySeverity;
  exploitKnown?: boolean;
}
