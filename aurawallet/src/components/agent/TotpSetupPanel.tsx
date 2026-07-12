'use client';

import React, { useMemo, useRef, useState } from 'react';
import { TextInput } from '@/components/design-system';
import { classifyTotpPayload, normalizeBase32Secret, parseTotpUri, type ParsedTotpUri } from '@/lib/totp-import';

type TotpIntent = 'keep' | 'replace' | 'remove';

type Props = {
  isEdit: boolean;
  hasExistingTotp: boolean;
  onIntentChange: (intent: TotpIntent) => void;
  onSecretChange: (secret: string, markDirty: boolean) => void;
};

export const TotpSetupPanel: React.FC<Props> = ({ isEdit, hasExistingTotp, onIntentChange, onSecretChange }) => {
  const [mode, setMode] = useState<'manual' | 'uri' | 'qr'>('manual');
  const [manualSecret, setManualSecret] = useState('');
  const [uriInput, setUriInput] = useState('');
  const [preview, setPreview] = useState<ParsedTotpUri | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDecoding, setIsDecoding] = useState(false);
  const decodeVersionRef = useRef(0);

  const hasMigrationPayload = useMemo(() => classifyTotpPayload(uriInput) === 'otpauth-migration', [uriInput]);

  const applyParsed = (parsed: ParsedTotpUri) => {
    setPreview(parsed);
    setError(null);
    onIntentChange('replace');
    onSecretChange(parsed.secret, true);
  };

  const handleManualChange = (value: string) => {
    setManualSecret(value);
    if (!value.trim()) {
      setPreview(null);
      onSecretChange('', false);
      return;
    }
    try {
      const normalized = normalizeBase32Secret(value);
      setError(null);
      setPreview({ secret: normalized, algorithm: 'SHA1', digits: 6, period: 30 });
      onIntentChange('replace');
      onSecretChange(normalized, true);
    } catch {
      setPreview(null);
      setError('Invalid TOTP secret');
      onSecretChange('', false);
    }
  };

  const parseUriInput = (value: string) => {
    if (!value.trim()) {
      setPreview(null);
      setError(null);
      onSecretChange('', false);
      return;
    }
    const kind = classifyTotpPayload(value);
    if (kind === 'otpauth-migration') {
      setPreview(null);
      setError(null);
      onSecretChange('', false);
      return;
    }
    if (kind !== 'otpauth') {
      setPreview(null);
      setError('Unsupported QR/setup payload. Use an otpauth://totp link.');
      onSecretChange('', false);
      return;
    }

    try {
      applyParsed(parseTotpUri(value));
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : 'Invalid TOTP setup link');
      onSecretChange('', false);
    }
  };

  const handleQrFile = async (file: File | null) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('QR image must be 5MB or smaller');
      return;
    }

    const currentVersion = ++decodeVersionRef.current;
    setIsDecoding(true);
    setError(null);

    try {
      if (typeof window === 'undefined' || !('BarcodeDetector' in window)) {
        throw new Error('QR decoding not supported in this browser. Paste setup link manually.');
      }
      const detector = new (window as unknown as { BarcodeDetector: new (opts: { formats: string[] }) => { detect: (source: ImageBitmap) => Promise<Array<{ rawValue?: string }>> } }).BarcodeDetector({ formats: ['qr_code'] });
      const bitmap = await createImageBitmap(file);
      try {
        if (bitmap.width > 4096 || bitmap.height > 4096) {
          throw new Error('QR image dimensions exceed 4096x4096 limit');
        }
        const codes = await detector.detect(bitmap);
        if (decodeVersionRef.current !== currentVersion) return;
        const payload = codes[0]?.rawValue || '';
        setUriInput(payload);
        parseUriInput(payload);
      } finally {
        bitmap.close();
      }
    } catch (err) {
      if (decodeVersionRef.current !== currentVersion) return;
      setPreview(null);
      setError(err instanceof Error ? err.message : 'Failed to decode QR image');
    } finally {
      if (decodeVersionRef.current === currentVersion) setIsDecoding(false);
    }
  };

  return (
    <div className="space-y-3 border border-[var(--color-border,#d4d4d8)] p-3 bg-[var(--color-background-alt,#f4f4f5)]" data-testid="totp-setup-panel">
      {isEdit && hasExistingTotp && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="font-mono text-[9px] px-2 py-1 border" onClick={() => { onIntentChange('keep'); setError(null); onSecretChange('', false); }}>
            Keep Existing
          </button>
          <button type="button" className="font-mono text-[9px] px-2 py-1 border" onClick={() => onIntentChange('replace')}>
            Replace TOTP
          </button>
          <button type="button" className="font-mono text-[9px] px-2 py-1 border" onClick={() => { onIntentChange('remove'); setPreview(null); setError(null); onSecretChange('', true); }}>
            Remove TOTP
          </button>
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" className="font-mono text-[9px] uppercase px-2 py-1 border" onClick={() => setMode('manual')}>Manual</button>
        <button type="button" className="font-mono text-[9px] uppercase px-2 py-1 border" onClick={() => setMode('uri')}>Paste Link</button>
        <button type="button" className="font-mono text-[9px] uppercase px-2 py-1 border" onClick={() => setMode('qr')}>Import QR</button>
      </div>

      {mode === 'manual' && (
        <TextInput
          label="TOTP Secret (2FA)"
          value={manualSecret}
          onChange={(e) => handleManualChange(e.target.value)}
          placeholder="Base32 secret (e.g. JBSWY3DPEHPK3PXP)"
          type="password"
        />
      )}

      {mode === 'uri' && (
        <div>
          <label className="block font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">Setup Link</label>
          <textarea
            className="w-full h-24 bg-[var(--color-background-alt,#f4f4f5)] border border-[var(--color-border,#d4d4d8)] font-mono text-sm p-3 resize-none"
            value={uriInput}
            onChange={(e) => { setUriInput(e.target.value); parseUriInput(e.target.value); }}
            placeholder="otpauth://totp/..."
            data-testid="totp-uri-input"
          />
        </div>
      )}

      {mode === 'qr' && (
        <div className="space-y-2">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => { void handleQrFile(e.target.files?.[0] || null); }}
            data-testid="totp-qr-file"
          />
          {isDecoding && <p className="font-mono text-[10px]" data-testid="totp-qr-decoding">Decoding QR…</p>}
        </div>
      )}

      {hasMigrationPayload && (
        <div className="font-mono text-[10px] border p-2" data-testid="totp-migration-fallback">
          Google Authenticator migration QR detected. v1 supports standard otpauth:// links only. Use manual setup or account-level QR when available.
        </div>
      )}

      {preview && (
        <div className="font-mono text-[10px] border p-2" data-testid="totp-preview">
          <div>Issuer: {preview.issuer || '—'}</div>
          <div>Account: {preview.account || '—'}</div>
          <div>Digits: {preview.digits}</div>
          <div>Period: {preview.period}s</div>
          <div>Algorithm: {preview.algorithm}</div>
        </div>
      )}

      {error && <div className="font-mono text-[10px] text-[var(--color-danger,#ef4444)]" data-testid="totp-error">{error}</div>}
    </div>
  );
};
