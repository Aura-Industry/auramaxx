'use client';

import React, { useState, useRef, useCallback, useMemo } from 'react';
import { Upload, FileText, AlertCircle, CheckCircle } from 'lucide-react';
import { Modal, Button, ItemPicker, FilterDropdown } from '@/components/design-system';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImportSource {
  label: string;
  format: string;
  supported: boolean;
}

const IMPORT_SOURCES: ImportSource[] = [
  { label: '1Password', format: '1password-csv', supported: true },
  { label: 'Bitwarden', format: 'bitwarden-csv', supported: true },
  { label: 'Chrome', format: 'chrome-csv', supported: true },
  { label: 'Firefox', format: 'firefox-csv', supported: true },
  { label: 'iCloud Keychain', format: 'icloud-csv', supported: true },
  { label: 'LastPass', format: 'lastpass-csv', supported: true },
];

type DuplicateStrategy = 'skip' | 'rename' | 'overwrite';

const STRATEGY_LABELS: Record<DuplicateStrategy, string> = {
  skip: 'Skip',
  rename: 'Rename',
  overwrite: 'Create Anyway',
};

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

type Step = 'select' | 'preview' | 'result';

interface ImportCredentialsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: () => void;
  agents: Array<{
    id: string;
    name?: string;
    isPrimary: boolean;
    isUnlocked: boolean;
  }>;
  selectedAgentId: string;
  onSelectedAgentIdChange: (agentId: string) => void;
  onAddAgent: () => void;
  walletBaseUrl: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  const localToken = localStorage.getItem('auramaxx_admin_token');
  if (localToken) return localToken;
  return sessionStorage.getItem('auramaxx_admin_token');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ImportCredentialsModal: React.FC<ImportCredentialsModalProps> = ({
  isOpen,
  onClose,
  onComplete,
  agents,
  selectedAgentId,
  onSelectedAgentIdChange,
  onAddAgent,
  walletBaseUrl,
}) => {
  const [step, setStep] = useState<Step>('select');
  const [selectedFormat, setSelectedFormat] = useState<string>('1password-csv');
  const [file, setFile] = useState<File | null>(null);
  const [duplicateStrategy, setDuplicateStrategy] = useState<DuplicateStrategy>('skip');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const reset = useCallback(() => {
    setStep('select');
    setSelectedFormat('1password-csv');
    setFile(null);
    setDuplicateStrategy('skip');
    setPreview(null);
    setResult(null);
    setLoading(false);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (f && f.size > MAX_FILE_SIZE) {
      setError(`File too large (${(f.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setFile(f);
    setError(null);
  }, []);

  const buildFormData = useCallback(
    (dryRun: boolean) => {
      if (!file) return null;
      const fd = new FormData();
      fd.append('file', file);
      fd.append('format', selectedFormat);
      fd.append('agentId', selectedAgentId || 'primary');
      if (dryRun) fd.append('dryRun', 'true');
      fd.append('duplicateStrategy', duplicateStrategy);
      return fd;
    },
    [file, selectedFormat, selectedAgentId, duplicateStrategy],
  );

  const handlePreview = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const fd = buildFormData(true);
      if (!fd) return;
      const token = getToken();
      const res = await fetch(`${walletBaseUrl}/credentials/import`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        setError(`Server error: ${res.status} ${res.statusText}`);
        return;
      }
      const data: PreviewResult = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || `Request failed: ${res.status}`);
        return;
      }
      setPreview(data);
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setLoading(false);
    }
  }, [file, buildFormData, walletBaseUrl]);

  const handleImport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fd = buildFormData(false);
      if (!fd) return;
      const token = getToken();
      const res = await fetch(`${walletBaseUrl}/credentials/import`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        setError(`Server error: ${res.status} ${res.statusText}`);
        return;
      }
      const data: ImportResult = await res.json();
      if (!res.ok) {
        setError(data.error || `Request failed: ${res.status}`);
        return;
      }
      setResult(data);
      setStep('result');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setLoading(false);
    }
  }, [buildFormData, walletBaseUrl]);

  const handleDone = useCallback(() => {
    onComplete();
    handleClose();
  }, [onComplete, handleClose]);

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  const selectedSource = IMPORT_SOURCES.find((s) => s.format === selectedFormat);

  const renderSelectStep = () => (
    <div className="space-y-5">
      {/* Source selector */}
      <div>
        <label className="block text-[9px] font-bold tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] mb-2">
          Source
        </label>
        <ItemPicker
          ariaLabel="Import source"
          value={selectedFormat}
          onChange={(value: string) => {
            const source = IMPORT_SOURCES.find((s) => s.format === value);
            if (source?.supported) setSelectedFormat(source.format);
          }}
          options={IMPORT_SOURCES.map((source) => ({
            value: source.format,
            label: source.label,
            description: source.supported ? undefined : 'Coming soon',
            icon: <FileText size={12} />,
          }))}
        />
      </div>

      {/* File input */}
      <div>
        <label className="block text-[9px] font-bold tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] mb-2">
          File
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={handleFileChange}
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

      {/* Agent target */}
      <div>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <FilterDropdown
              label="Target Agent"
              ariaLabel="TARGET AGENT"
              options={agentOptions}
              value={selectedAgentId}
              onChange={onSelectedAgentIdChange}
              compact
              searchable
              menuPosition="top"
              searchPlaceholder="Search agent..."
              emptyMessage="No agent matches"
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onAddAgent}
            className="!h-[var(--control-height-sm)] !px-3"
          >
            ADD
          </Button>
        </div>
        {selectedAgent && !selectedAgent.isUnlocked && (
          <div className="mt-2 text-[9px] text-[var(--color-warning,#ff4d00)] border border-[var(--color-warning,#ff4d00)]/30 bg-[var(--color-warning,#ff4d00)]/10 px-3 py-2">
            Selected agent is locked. Unlock it before preview/import.
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200">
          <AlertCircle size={12} className="text-red-500 flex-shrink-0 mt-0.5" />
          <span className="text-[10px] font-mono text-red-700">{error}</span>
        </div>
      )}

    </div>
  );

  const renderPreviewStep = () => {
    if (!preview) return null;
    return (
      <div className="space-y-4">
        {/* Summary */}
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

        {/* Preview list */}
        <div className="max-h-[240px] overflow-y-auto border border-[var(--color-border,#d4d4d8)]">
          {preview.credentials.length === 0 ? (
            <div className="px-4 py-8 text-center text-[10px] font-mono text-[var(--color-text-muted,#6b7280)]">
              No credentials found in file
            </div>
          ) : (
            preview.credentials.map((c, i) => (
              <div
                key={i}
                className={`flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border,#d4d4d8)] last:border-b-0 ${
                  c.isDuplicate ? 'bg-amber-50/50' : ''
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-mono text-[var(--color-text,#0a0a0a)] truncate">
                    {c.name}
                  </div>
                  {c.url && (
                    <div className="text-[8px] font-mono text-[var(--color-text-faint,#9ca3af)] truncate">
                      {c.url}
                    </div>
                  )}
                </div>
                <span className="text-[8px] font-mono tracking-wider uppercase text-[var(--color-text-faint,#9ca3af)] flex-shrink-0">
                  {c.type}
                </span>
                {c.isDuplicate && (
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

        {/* Duplicate strategy */}
        {preview.duplicates > 0 && (
          <div>
            <label className="block text-[9px] font-bold tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] mb-1.5">
              Duplicate handling
            </label>
            <div className="flex gap-1.5">
              {(['skip', 'rename', 'overwrite'] as DuplicateStrategy[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setDuplicateStrategy(s)}
                  className={`px-3 py-1.5 text-[9px] font-mono tracking-wider uppercase border transition-colors ${
                    duplicateStrategy === s
                      ? 'border-[var(--color-accent,#ccff00)] bg-[var(--color-accent,#ccff00)]/10 text-[var(--color-text,#0a0a0a)]'
                      : 'border-[var(--color-border,#d4d4d8)] text-[var(--color-text-muted,#6b7280)] hover:bg-[var(--color-background-alt,#f4f4f5)]'
                  }`}
                >
                  {STRATEGY_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200">
            <AlertCircle size={12} className="text-red-500 flex-shrink-0 mt-0.5" />
            <span className="text-[10px] font-mono text-red-700">{error}</span>
          </div>
        )}

      </div>
    );
  };

  const renderResultStep = () => {
    if (!result) return null;
    const hasErrors = result.errors.length > 0;
    return (
      <div className="space-y-4">
        {/* Result icon */}
        <div className="flex items-center gap-3">
          {result.success ? (
            <CheckCircle size={20} className="text-green-600" />
          ) : (
            <AlertCircle size={20} className="text-red-500" />
          )}
          <div>
            <div className="text-[11px] font-mono font-bold text-[var(--color-text,#0a0a0a)]">
              {result.success ? 'Import Complete' : 'Import Failed'}
            </div>
          </div>
        </div>

        {/* Counts */}
        <div className="flex gap-6">
          <div className="text-center">
            <div className="text-[18px] font-bold font-mono text-green-600">{result.imported}</div>
            <div className="text-[8px] font-mono tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
              Imported
            </div>
          </div>
          {result.skipped > 0 && (
            <div className="text-center">
              <div className="text-[18px] font-bold font-mono text-[var(--color-text-muted,#6b7280)]">
                {result.skipped}
              </div>
              <div className="text-[8px] font-mono tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
                Skipped
              </div>
            </div>
          )}
          {hasErrors && (
            <div className="text-center">
              <div className="text-[18px] font-bold font-mono text-red-500">
                {result.errors.length}
              </div>
              <div className="text-[8px] font-mono tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
                Errors
              </div>
            </div>
          )}
        </div>

        {/* Error details */}
        {hasErrors && (
          <div className="max-h-[120px] overflow-y-auto border border-red-200 bg-red-50">
            {result.errors.map((e, i) => (
              <div
                key={i}
                className="px-3 py-1 text-[9px] font-mono text-red-700 border-b border-red-100 last:border-b-0"
              >
                Row {e.row}: {e.reason}
              </div>
            ))}
          </div>
        )}

      </div>
    );
  };

  const renderFooter = () => {
    if (step === 'select') {
      return (
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={handleClose}>
            CANCEL
          </Button>
          <Button
            size="sm"
            onClick={handlePreview}
            loading={loading}
            disabled={!file || !selectedSource?.supported}
          >
            PREVIEW
          </Button>
        </div>
      );
    }

    if (step === 'preview' && preview) {
      const importCount = duplicateStrategy === 'skip' ? preview.total - preview.duplicates : preview.total;
      return (
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setStep('select');
              setError(null);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
          >
            BACK
          </Button>
          <Button
            size="sm"
            onClick={handleImport}
            loading={loading}
            disabled={preview.credentials.length === 0}
          >
            IMPORT {importCount} CREDENTIAL{importCount !== 1 ? 'S' : ''}
          </Button>
        </div>
      );
    }

    if (step === 'result') {
      return (
        <div className="flex justify-end">
          <Button size="sm" onClick={handleDone}>
            DONE
          </Button>
        </div>
      );
    }

    return null;
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Import Credentials"
      size="md"
      footer={renderFooter()}
    >
      {step === 'select' && renderSelectStep()}
      {step === 'preview' && renderPreviewStep()}
      {step === 'result' && renderResultStep()}
    </Modal>
  );
};
