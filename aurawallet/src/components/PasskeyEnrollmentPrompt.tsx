'use client';

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { KeyRound, Check, Upload, FileText, AlertCircle, CheckCircle } from 'lucide-react';
import { Modal, Button, ItemPicker, FilterDropdown } from '@/components/design-system';
import { api, Api, getWalletBaseUrl } from '@/lib/api';
import { CredentialForm } from '@/components/agent/CredentialForm';
import type { AgentInfo } from '@/components/agent/types';

type PromptMode = 'hidden' | 'onboarding' | 'passkey';
type OnboardingStep = 'import-source' | 'import-upload' | 'retrieve-note' | 'passkey' | 'passkey-success';
type ImportStep = 'upload' | 'preview' | 'result';
type DuplicateStrategy = 'skip' | 'rename' | 'overwrite';

interface ImportSource {
  label: string;
  format: string;
}

interface PreviewCredential {
  name: string;
  type: string;
  url?: string;
  fieldCount: number;
  isDuplicate: boolean;
  duplicateMatch?: string;
}

interface PreviewResult {
  success: boolean;
  total: number;
  duplicates: number;
  credentials: PreviewCredential[];
  error?: string;
}

interface ImportResult {
  success: boolean;
  imported: number;
  skipped: number;
  errors: { row: number; reason: string }[];
  error?: string;
}

const PASSKEY_DISMISS_KEY = 'aura:passkey:dismissed';
const ONBOARDING_DONE_KEY = 'aura:onboarding:done';
const TOP_IMPORT_SOURCE_FORMATS = ['1password-csv', 'bitwarden-csv', 'chrome-csv'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const FIRST_NOTE_HELPERS = ['aura to maxx', 'maxx to aura'] as const;

const IMPORT_SOURCES: ImportSource[] = [
  { label: '1Password', format: '1password-csv' },
  { label: 'Bitwarden', format: 'bitwarden-csv' },
  { label: 'Chrome', format: 'chrome-csv' },
  { label: 'Firefox', format: 'firefox-csv' },
  { label: 'iCloud Keychain', format: 'icloud-csv' },
  { label: 'LastPass', format: 'lastpass-csv' },
];

const STRATEGY_LABELS: Record<DuplicateStrategy, string> = {
  skip: 'Skip',
  rename: 'Rename',
  overwrite: 'Create Anyway',
};

/** Convert base64url string to ArrayBuffer */
function base64urlToBuffer(b: string): ArrayBuffer {
  let s = b.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a.buffer;
}

/** Convert ArrayBuffer to base64url string */
function bufferToBase64url(b: ArrayBuffer): string {
  const bytes = new Uint8Array(b);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  const localToken = localStorage.getItem('auramaxx_admin_token');
  if (localToken) return localToken;
  return sessionStorage.getItem('auramaxx_admin_token');
}

interface PasskeyEnrollmentPromptProps {
  isUnlocked: boolean;
}

export function PasskeyEnrollmentPrompt({ isUnlocked }: PasskeyEnrollmentPromptProps) {
  const walletBaseUrl = useMemo(() => getWalletBaseUrl(), []);
  const firstNoteHelper = useMemo(
    () => FIRST_NOTE_HELPERS[Math.floor(Math.random() * FIRST_NOTE_HELPERS.length)],
    [],
  );

  const [mode, setMode] = useState<PromptMode>('hidden');
  const [step, setStep] = useState<OnboardingStep>('import-source');
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [showMoreSources, setShowMoreSources] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState<string>(TOP_IMPORT_SOURCE_FORMATS[0]);
  const [importStep, setImportStep] = useState<ImportStep>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [duplicateStrategy, setDuplicateStrategy] = useState<DuplicateStrategy>('skip');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('primary');
  const [showCreateCredential, setShowCreateCredential] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const visibleImportSources = useMemo(() => (
    showMoreSources
      ? IMPORT_SOURCES
      : IMPORT_SOURCES.filter((source) => TOP_IMPORT_SOURCE_FORMATS.includes(source.format))
  ), [showMoreSources]);

  const agentOptions = useMemo(
    () => agents.map((agent) => ({
      value: agent.id,
      label: agent.name || (agent.isPrimary ? 'Primary' : `Agent ${agent.id.slice(0, 6)}`),
    })),
    [agents],
  );

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || null,
    [agents, selectedAgentId],
  );

  const resetImportState = useCallback(() => {
    setImportStep('upload');
    setFile(null);
    setDuplicateStrategy('skip');
    setPreview(null);
    setImportResult(null);
    setImportLoading(false);
    setImportError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const completeOnboarding = useCallback((dismissPasskey = false) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(ONBOARDING_DONE_KEY, 'true');
      if (dismissPasskey) {
        localStorage.setItem(PASSKEY_DISMISS_KEY, 'true');
      }
    }
    setMode('hidden');
    setStep('import-source');
    setShowMoreSources(false);
    setSelectedFormat(TOP_IMPORT_SOURCE_FORMATS[0]);
    setPasskeyError(null);
    setPasskeyLoading(false);
    resetImportState();
  }, [resetImportState]);

  const handleSkipImportToCreate = useCallback(() => {
    setStep('retrieve-note');
    setShowCreateCredential(true);
  }, []);

  const dismissPasskeyOnly = useCallback(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(PASSKEY_DISMISS_KEY, 'true');
    }
    setMode('hidden');
    setPasskeyError(null);
    setPasskeyLoading(false);
  }, []);

  const fetchAgents = useCallback(async () => {
    try {
      const response = await api.get<{ success: boolean; agents: AgentInfo[] }>(Api.Wallet, '/agents/credential');
      if (!response.success || !Array.isArray(response.agents)) return;
      setAgents(response.agents);
      const primaryId = response.agents.find((agent) => agent.isPrimary)?.id || response.agents[0]?.id || 'primary';
      setSelectedAgentId((current) => {
        if (current && response.agents.some((agent) => agent.id === current)) return current;
        return primaryId;
      });
    } catch {
      // Fail closed: keep defaults, don't block onboarding flow.
    }
  }, []);

  useEffect(() => {
    if (!isUnlocked) {
      setMode('hidden');
      return;
    }
    if (typeof window === 'undefined') return;

    let cancelled = false;

    const hydratePrompt = async () => {
      const onboardingDone = localStorage.getItem(ONBOARDING_DONE_KEY) === 'true';
      const passkeyDismissed = localStorage.getItem(PASSKEY_DISMISS_KEY) === 'true';
      const desktopRuntime = Boolean((window as unknown as Record<string, unknown>).auraDesktop);
      const webAuthnSupported = Boolean(window.PublicKeyCredential) && !desktopRuntime;
      setPasskeySupported(webAuthnSupported);

      let passkeyRegistered = false;
      if (webAuthnSupported) {
        try {
          const status = await api.get<{ registered?: boolean }>(Api.Wallet, '/auth/passkey/status');
          passkeyRegistered = status.registered === true;
        } catch {
          passkeyRegistered = false;
        }
      }

      const shouldShowOnboarding = !onboardingDone;

      if (cancelled) return;

      if (shouldShowOnboarding) {
        await fetchAgents();
        if (cancelled) return;
        setMode('onboarding');
        setStep('import-source');
        return;
      }

      if (webAuthnSupported && !passkeyRegistered && !passkeyDismissed) {
        setMode('passkey');
        setStep('passkey');
        return;
      }

      setMode('hidden');
    };

    void hydratePrompt();

    return () => {
      cancelled = true;
    };
  }, [fetchAgents, isUnlocked]);

  const buildFormData = useCallback((dryRun: boolean) => {
    if (!file) return null;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('format', selectedFormat);
    fd.append('agentId', selectedAgentId || 'primary');
    if (dryRun) fd.append('dryRun', 'true');
    fd.append('duplicateStrategy', duplicateStrategy);
    return fd;
  }, [duplicateStrategy, file, selectedFormat, selectedAgentId]);

  const handlePreviewImport = useCallback(async () => {
    if (!file) return;
    setImportLoading(true);
    setImportError(null);
    try {
      const formData = buildFormData(true);
      if (!formData) return;
      const token = getToken();
      const res = await fetch(`${walletBaseUrl}/credentials/import`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        setImportError(`Server error: ${res.status} ${res.statusText}`);
        return;
      }
      const data: PreviewResult = await res.json();
      if (!res.ok || !data.success) {
        setImportError(data.error || `Request failed: ${res.status}`);
        return;
      }
      setPreview(data);
      setImportStep('preview');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setImportLoading(false);
    }
  }, [buildFormData, file, walletBaseUrl]);

  const handleRunImport = useCallback(async () => {
    setImportLoading(true);
    setImportError(null);
    try {
      const formData = buildFormData(false);
      if (!formData) return;
      const token = getToken();
      const res = await fetch(`${walletBaseUrl}/credentials/import`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        setImportError(`Server error: ${res.status} ${res.statusText}`);
        return;
      }
      const data: ImportResult = await res.json();
      if (!res.ok) {
        setImportError(data.error || `Request failed: ${res.status}`);
        return;
      }
      setImportResult(data);
      setImportStep('result');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportLoading(false);
    }
  }, [buildFormData, walletBaseUrl]);

  const handlePasskeySetup = useCallback(async () => {
    if (!passkeySupported) {
      setPasskeyError('Passkey is not available in this environment.');
      return;
    }

    setPasskeyLoading(true);
    setPasskeyError(null);
    try {
      const options = await api.post<{
        challenge: string;
        rp: { name: string; id: string };
        user: { id: string; name: string; displayName: string };
        pubKeyCredParams: Array<{ type: string; alg: number }>;
        timeout: number;
        attestation: string;
        excludeCredentials: Array<{ id: string; transports?: string[] }>;
        authenticatorSelection: {
          authenticatorAttachment?: string;
          residentKey?: string;
          userVerification?: string;
        };
      }>(Api.Wallet, '/auth/passkey/register/options', {});

      const publicKey: PublicKeyCredentialCreationOptions = {
        challenge: base64urlToBuffer(options.challenge),
        rp: { name: options.rp.name, id: options.rp.id },
        user: {
          id: base64urlToBuffer(options.user.id),
          name: options.user.name,
          displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams.map((p) => ({
          type: p.type as 'public-key',
          alg: p.alg,
        })),
        timeout: options.timeout,
        attestation: (options.attestation || 'none') as AttestationConveyancePreference,
        excludeCredentials: (options.excludeCredentials || []).map((c) => ({
          type: 'public-key' as const,
          id: base64urlToBuffer(c.id),
          transports: c.transports as AuthenticatorTransport[] | undefined,
        })),
        authenticatorSelection: {
          authenticatorAttachment: options.authenticatorSelection?.authenticatorAttachment as AuthenticatorAttachment | undefined,
          residentKey: options.authenticatorSelection?.residentKey as ResidentKeyRequirement | undefined,
          userVerification: options.authenticatorSelection?.userVerification as UserVerificationRequirement | undefined,
        },
      };

      const credential = await navigator.credentials.create({ publicKey }) as PublicKeyCredential | null;
      if (!credential) {
        setPasskeyLoading(false);
        return;
      }

      const response = credential.response as AuthenticatorAttestationResponse;
      const verifyPayload = {
        credential: {
          id: bufferToBase64url(credential.rawId),
          rawId: bufferToBase64url(credential.rawId),
          type: credential.type,
          response: {
            clientDataJSON: bufferToBase64url(response.clientDataJSON),
            attestationObject: bufferToBase64url(response.attestationObject),
            transports: response.getTransports?.() || [],
          },
        },
      };

      const result = await api.post<{ success: boolean; error?: string }>(
        Api.Wallet,
        '/auth/passkey/register/verify',
        verifyPayload,
      );

      if (!result.success) {
        setPasskeyError(result.error || 'Passkey registration failed.');
        return;
      }

      if (mode === 'onboarding') {
        setStep('passkey-success');
        setTimeout(() => completeOnboarding(false), 1200);
      } else {
        setMode('hidden');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setPasskeyLoading(false);
        return;
      }
      setPasskeyError(err instanceof Error ? err.message : 'Passkey registration failed.');
    } finally {
      setPasskeyLoading(false);
    }
  }, [completeOnboarding, mode, passkeySupported]);

  const renderImportUploadStep = () => {
    if (importStep === 'preview' && preview) {
      const importCount = duplicateStrategy === 'skip' ? preview.total - preview.duplicates : preview.total;
      return (
        <div className="space-y-4">
          <div className="flex gap-4">
            <div className="text-center">
              <div className="text-[18px] font-bold font-mono text-[var(--color-text,#0a0a0a)]">
                {preview.total}
              </div>
              <div className="text-[8px] font-mono tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
                Total
              </div>
            </div>
            {preview.duplicates > 0 && (
              <div className="text-center">
                <div className="text-[18px] font-bold font-mono text-amber-600">
                  {preview.duplicates}
                </div>
                <div className="text-[8px] font-mono tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
                  Duplicates
                </div>
              </div>
            )}
          </div>

          <div className="max-h-[220px] overflow-y-auto border border-[var(--color-border,#d4d4d8)]">
            {preview.credentials.length === 0 ? (
              <div className="px-4 py-8 text-center text-[10px] font-mono text-[var(--color-text-muted,#6b7280)]">
                No credentials found in file.
              </div>
            ) : (
              preview.credentials.map((credential, index) => (
                <div
                  key={`${credential.name}-${index}`}
                  className={`flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border,#d4d4d8)] last:border-b-0 ${
                    credential.isDuplicate ? 'bg-amber-50/50' : ''
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] font-mono text-[var(--color-text,#0a0a0a)] truncate">
                      {credential.name}
                    </div>
                    {credential.url && (
                      <div className="text-[8px] font-mono text-[var(--color-text-faint,#9ca3af)] truncate">
                        {credential.url}
                      </div>
                    )}
                  </div>
                  <span className="text-[8px] font-mono tracking-wider uppercase text-[var(--color-text-faint,#9ca3af)] flex-shrink-0">
                    {credential.type}
                  </span>
                  {credential.isDuplicate && (
                    <span className="text-[8px] font-mono tracking-wider uppercase text-amber-600 flex-shrink-0">
                      DUP
                    </span>
                  )}
                </div>
              ))
            )}
            {preview.total > preview.credentials.length && (
              <div className="px-3 py-1.5 text-[9px] font-mono text-[var(--color-text-faint,#9ca3af)] text-center">
                + {preview.total - preview.credentials.length} more
              </div>
            )}
          </div>

          {preview.duplicates > 0 && (
            <div>
              <label className="block text-[9px] font-bold tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] mb-1.5">
                Duplicate handling
              </label>
              <div className="flex gap-1.5">
                {(['skip', 'rename', 'overwrite'] as DuplicateStrategy[]).map((strategy) => (
                  <button
                    key={strategy}
                    onClick={() => setDuplicateStrategy(strategy)}
                    className={`px-3 py-1.5 text-[9px] font-mono tracking-wider uppercase border transition-colors ${
                      duplicateStrategy === strategy
                        ? 'border-[var(--color-accent,#ccff00)] bg-[var(--color-accent,#ccff00)]/10 text-[var(--color-text,#0a0a0a)]'
                        : 'border-[var(--color-border,#d4d4d8)] text-[var(--color-text-muted,#6b7280)] hover:bg-[var(--color-background-alt,#f4f4f5)]'
                    }`}
                  >
                    {STRATEGY_LABELS[strategy]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {importError && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200">
              <AlertCircle size={12} className="text-red-500 flex-shrink-0 mt-0.5" />
              <span className="text-[10px] font-mono text-red-700">{importError}</span>
            </div>
          )}

          <div className="flex justify-between gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                resetImportState();
                handleSkipImportToCreate();
              }}
            >
              SKIP
            </Button>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setImportStep('upload');
                  setImportError(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
              >
                BACK
              </Button>
              <Button
                size="sm"
                onClick={() => { void handleRunImport(); }}
                loading={importLoading}
                disabled={preview.credentials.length === 0}
              >
                IMPORT {importCount} CREDENTIAL{importCount !== 1 ? 'S' : ''}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    if (importStep === 'result' && importResult) {
      const hasErrors = importResult.errors.length > 0;
      return (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            {importResult.success ? (
              <CheckCircle size={20} className="text-green-600" />
            ) : (
              <AlertCircle size={20} className="text-red-500" />
            )}
            <div>
              <div className="text-[11px] font-mono font-bold text-[var(--color-text,#0a0a0a)]">
                {importResult.success ? 'Import Complete' : 'Import Failed'}
              </div>
            </div>
          </div>

          <div className="flex gap-6">
            <div className="text-center">
              <div className="text-[18px] font-bold font-mono text-green-600">{importResult.imported}</div>
              <div className="text-[8px] font-mono tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
                Imported
              </div>
            </div>
            {importResult.skipped > 0 && (
              <div className="text-center">
                <div className="text-[18px] font-bold font-mono text-[var(--color-text-muted,#6b7280)]">
                  {importResult.skipped}
                </div>
                <div className="text-[8px] font-mono tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
                  Skipped
                </div>
              </div>
            )}
            {hasErrors && (
              <div className="text-center">
                <div className="text-[18px] font-bold font-mono text-red-500">
                  {importResult.errors.length}
                </div>
                <div className="text-[8px] font-mono tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
                  Errors
                </div>
              </div>
            )}
          </div>

          {hasErrors && (
            <div className="max-h-[120px] overflow-y-auto border border-red-200 bg-red-50">
              {importResult.errors.map((item, index) => (
                <div
                  key={`${item.row}-${index}`}
                  className="px-3 py-1 text-[9px] font-mono text-red-700 border-b border-red-100 last:border-b-0"
                >
                  Row {item.row}: {item.reason}
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                resetImportState();
                setStep('retrieve-note');
              }}
            >
              CONTINUE
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-5">
        <div>
          <label className="block text-[9px] font-bold tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] mb-2">
            Source
          </label>
          <div className="text-[10px] font-mono text-[var(--color-text,#0a0a0a)] px-3 py-2 border border-[var(--color-border,#d4d4d8)]">
            {IMPORT_SOURCES.find((source) => source.format === selectedFormat)?.label || selectedFormat}
          </div>
        </div>

        <div>
          <label className="block text-[9px] font-bold tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] mb-2">
            File
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={(event) => {
              const nextFile = event.target.files?.[0] ?? null;
              if (nextFile && nextFile.size > MAX_FILE_SIZE) {
                setImportError(`File too large (${(nextFile.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`);
                setFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
                return;
              }
              setFile(nextFile);
              setImportError(null);
            }}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 px-4 py-4 border-2 border-dashed border-[var(--color-border,#d4d4d8)] hover:border-[var(--color-text-muted,#6b7280)] transition-colors"
          >
            <Upload size={14} className="text-[var(--color-text-muted,#6b7280)]" />
            <span className="text-[10px] font-mono tracking-wider text-[var(--color-text-muted,#6b7280)]">
              {file ? file.name : 'Choose CSV file'}
            </span>
          </button>
        </div>

        <div>
          <FilterDropdown
            label="Target Agent"
            ariaLabel="TARGET AGENT"
            options={agentOptions}
            value={selectedAgentId}
            onChange={setSelectedAgentId}
            compact
            searchable
            menuPosition="top"
            searchPlaceholder="Search agent..."
            emptyMessage="No agent matches"
            disabled={agentOptions.length === 0}
          />
          {selectedAgent && !selectedAgent.isUnlocked && (
            <div className="mt-2 text-[9px] text-[var(--color-warning,#ff4d00)] border border-[var(--color-warning,#ff4d00)]/30 bg-[var(--color-warning,#ff4d00)]/10 px-3 py-2">
              Selected agent is locked. Unlock it before preview/import.
            </div>
          )}
        </div>

        {importError && (
          <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200">
            <AlertCircle size={12} className="text-red-500 flex-shrink-0 mt-0.5" />
            <span className="text-[10px] font-mono text-red-700">{importError}</span>
          </div>
        )}

        <div className="flex justify-between gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              resetImportState();
              handleSkipImportToCreate();
            }}
          >
            SKIP
          </Button>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                resetImportState();
                setStep('import-source');
              }}
            >
              BACK
            </Button>
            <Button
              size="sm"
              onClick={() => { void handlePreviewImport(); }}
              loading={importLoading}
              disabled={!file}
            >
              PREVIEW
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const renderOnboardingBody = () => {
    if (step === 'passkey-success') {
      return (
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="w-10 h-10 bg-[var(--color-text,#0a0a0a)] flex items-center justify-center">
            <Check size={20} className="text-[var(--color-accent,#ccff00)]" />
          </div>
          <div className="font-mono text-xs tracking-widest text-[var(--color-text,#0a0a0a)] uppercase">
            Passkey enabled!
          </div>
          <div className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">
            Onboarding complete.
          </div>
        </div>
      );
    }

    if (step === 'import-source') {
      return (
        <div className="space-y-4">
          <div className="font-mono text-xs text-[var(--color-text,#0a0a0a)] leading-relaxed">
            Import credentials from another manager before you continue.
          </div>

          <div className="space-y-2">
            <label className="block text-[9px] font-bold tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
              Import Source
            </label>
            <ItemPicker
              ariaLabel="Onboarding import source"
              value={selectedFormat}
              onChange={(value: string) => setSelectedFormat(value)}
              options={visibleImportSources.map((source) => ({
                value: source.format,
                label: source.label,
                icon: <FileText size={12} />,
              }))}
            />
          </div>

          <button
            type="button"
            onClick={() => setShowMoreSources((current) => !current)}
            className="font-mono text-[10px] tracking-widest text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
          >
            {showMoreSources ? 'SHOW LESS' : 'SHOW MORE'}
          </button>

          <div className="flex justify-between gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                resetImportState();
                handleSkipImportToCreate();
              }}
            >
              SKIP
            </Button>
            <Button
              size="sm"
              onClick={() => {
                resetImportState();
                setStep('import-upload');
              }}
            >
              CONFIRM
            </Button>
          </div>
        </div>
      );
    }

    if (step === 'import-upload') {
      return renderImportUploadStep();
    }

    if (step === 'retrieve-note') {
      return (
        <div className="space-y-4">
          <div className="font-mono text-xs text-[var(--color-text,#0a0a0a)] leading-relaxed">
            Retrieve your note before passkey setup.
          </div>

          <div className="space-y-2 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background-alt,#f4f4f5)] px-3 py-2">
            <div className="font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
              Dev Command
            </div>
            <div className="font-mono text-[11px] text-[var(--color-text,#0a0a0a)] break-all">
              $ npx auramaxx get FIRSTAURA
            </div>
          </div>

          <div className="space-y-2 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)] px-3 py-2">
            <div className="font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
              Agent Prompt
            </div>
            <div className="font-mono text-[11px] text-[var(--color-text,#0a0a0a)]">
              ayo get my FIRSTAURA using auramaxx
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => setStep('passkey')}
            >
              CONTINUE
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="font-mono text-xs text-[var(--color-text,#0a0a0a)] leading-relaxed">
          Enable Face ID / Passkey to unlock your agent without typing a password.
        </div>

        {!passkeySupported && (
          <div className="p-2 border border-[var(--color-warning,#ff4d00)]/30 bg-[var(--color-warning,#ff4d00)]/5">
            <div className="font-mono text-[10px] text-[var(--color-warning,#ff4d00)]">
              Passkey is unavailable in this environment.
            </div>
          </div>
        )}

        {passkeyError && (
          <div className="p-2 border border-[var(--color-warning,#ff4d00)]/30 bg-[var(--color-warning,#ff4d00)]/5">
            <div className="font-mono text-[10px] text-[var(--color-warning,#ff4d00)]">
              {passkeyError}
            </div>
          </div>
        )}

        <div className="flex justify-between gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => completeOnboarding(true)}
          >
            NOT NOW
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={passkeyLoading}
            onClick={() => { void handlePasskeySetup(); }}
            disabled={!passkeySupported}
            icon={<KeyRound size={14} />}
          >
            {passkeyLoading ? 'REGISTERING...' : 'CREATE PASSKEY'}
          </Button>
        </div>
      </div>
    );
  };

  const renderPasskeyOnlyBody = () => (
    <div className="space-y-4">
      <div className="font-mono text-xs text-[var(--color-text,#0a0a0a)] leading-relaxed">
        Enable Face ID / Passkey to unlock your agent without typing a password.
      </div>

      {passkeyError && (
        <div className="p-2 border border-[var(--color-warning,#ff4d00)]/30 bg-[var(--color-warning,#ff4d00)]/5">
          <div className="font-mono text-[10px] text-[var(--color-warning,#ff4d00)]">
            {passkeyError}
          </div>
        </div>
      )}

      <div className="flex justify-between gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={dismissPasskeyOnly}
        >
          NOT NOW
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={passkeyLoading}
          onClick={() => { void handlePasskeySetup(); }}
          icon={<KeyRound size={14} />}
        >
          {passkeyLoading ? 'REGISTERING...' : 'CREATE PASSKEY'}
        </Button>
      </div>
    </div>
  );

  const isOpen = mode !== 'hidden';
  const title = mode === 'onboarding'
    ? (step === 'passkey' || step === 'passkey-success' ? 'Passkey Setup' : 'Onboarding')
    : 'Passkey Setup';

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={() => {}}
        dismissible={false}
        title={title}
        subtitle="Security"
        icon={<KeyRound size={16} className="text-[var(--color-accent,#ccff00)]" />}
        size="md"
      >
        {mode === 'onboarding' ? renderOnboardingBody() : renderPasskeyOnlyBody()}
      </Modal>

      <CredentialForm
        isOpen={showCreateCredential}
        onClose={() => {
          setShowCreateCredential(false);
          setStep('retrieve-note');
        }}
        onSaved={() => {
          setShowCreateCredential(false);
          setStep('retrieve-note');
          void fetchAgents();
        }}
        agents={agents}
        createStartStep="form"
        createStartType="plain_note"
        createPrefill={{
          type: 'plain_note',
          name: 'FIRSTAURA',
          noteContent: firstNoteHelper,
          agentId: selectedAgentId !== 'primary' ? selectedAgentId : undefined,
        }}
      />
    </>
  );
}
