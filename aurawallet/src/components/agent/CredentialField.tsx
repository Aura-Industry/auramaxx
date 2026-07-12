'use client';

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { ChevronDown, Copy, Eye, EyeOff, Maximize2, Loader2 } from 'lucide-react';
import { Popover } from '@/components/design-system';
import { decryptCredentialPayload } from '@/lib/agent-crypto';
import { api, Api } from '@/lib/api';
import { canonicalizeCredentialFieldKey, NOTE_CONTENT_KEY } from '@/lib/credential-field-schema';
import { renderMarkdownToHtml } from '@/lib/markdown';

type SensitiveInteractionMode = 'default' | 'hover-copy' | 'markdown-hover-copy';

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

interface CredentialFieldProps {
  label: string;
  value?: string;
  copyValue?: string;
  trailingValue?: React.ReactNode;
  credentialId: string;
  fieldKey: string;
  isSensitive: boolean;
  onShowLargeType: (value: string) => void;
  sensitiveInteractionMode?: SensitiveInteractionMode;
  actionsPosition?: 'left' | 'right';
  showActionsInHoverCopyMode?: boolean;
  sensitiveClickBehavior?: 'reveal' | 'copy';
  disableLargeType?: boolean;
  renderMarkdown?: boolean;
}

export const CredentialField: React.FC<CredentialFieldProps> = ({
  label,
  value,
  copyValue,
  trailingValue,
  credentialId,
  fieldKey,
  isSensitive,
  onShowLargeType,
  sensitiveInteractionMode = 'default',
  actionsPosition = 'left',
  showActionsInHoverCopyMode = false,
  sensitiveClickBehavior = 'reveal',
  disableLargeType = false,
  renderMarkdown = false,
}) => {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const isHoverCopyMode = sensitiveInteractionMode === 'hover-copy' || sensitiveInteractionMode === 'markdown-hover-copy';
  const isMarkdownMode = sensitiveInteractionMode === 'markdown-hover-copy';
  const isRowHoverCopyMode = sensitiveInteractionMode === 'hover-copy';
  const isSensitiveClickCopyMode = !isHoverCopyMode && sensitiveClickBehavior === 'copy';
  const canShowSensitiveActions = !isHoverCopyMode || showActionsInHoverCopyMode;

  const markdownHtml = useMemo(() => {
    if (!isMarkdownMode || revealedValue == null) return '';
    return renderMarkdownToHtml(escapeHtml(revealedValue), {
      preserveSingleLineBreaks: true,
      decodeEscapedNewlines: true,
    });
  }, [isMarkdownMode, revealedValue]);

  const plainMarkdownHtml = useMemo(() => {
    if (!renderMarkdown || !value) return '';
    return renderMarkdownToHtml(escapeHtml(value), {
      preserveSingleLineBreaks: true,
      decodeEscapedNewlines: true,
    });
  }, [renderMarkdown, value]);

  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setCopied(false);
    setRevealed(false);
    setRevealedValue(null);
    setError(null);
    setMenuOpen(false);
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
  }, [credentialId, fieldKey]);

  // Auto-decrypt intentionally removed for markdown notes to avoid layout shift.
  // User clicks to reveal first, then clicks again to copy.

  const markCopied = useCallback(() => {
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  const revealForWindow = useCallback((val: string) => {
    setRevealedValue(val);
    setRevealed(true);
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(() => {
      setRevealed(false);
      setRevealedValue(null);
    }, 30000);
  }, []);

  // Silent decrypt — no spinner / no visual state changes.
  // Use for copy and large-type where layout must stay stable.
  const decryptFieldSilent = useCallback(async (): Promise<string | null> => {
    if (revealedValue != null) return revealedValue;
    try {
      const res = await api.post<{ encrypted: string }>(Api.Wallet, `/credentials/${credentialId}/read`);
      const plaintext = await decryptCredentialPayload(res.encrypted);
      const parsed = JSON.parse(plaintext) as {
        type?: string;
        fields?: Array<{ key: string; value: string }>;
      };
      const credentialType = typeof parsed.type === 'string' ? parsed.type : '';
      const canonicalTargetKey = canonicalizeCredentialFieldKey(credentialType, fieldKey);
      const field = parsed.fields?.find((f) => (
        canonicalizeCredentialFieldKey(credentialType, f.key) === canonicalTargetKey
        || (fieldKey === NOTE_CONTENT_KEY && f.key === 'value')
      ));
      if (!field) return null;
      return field.value;
    } catch {
      return null;
    }
  }, [credentialId, fieldKey, revealedValue]);

  // Visual decrypt — shows spinner. Used for reveal where user expects feedback.
  const decryptField = useCallback(async (): Promise<string | null> => {
    if (revealedValue != null) return revealedValue;
    setDecrypting(true);
    setError(null);
    try {
      const val = await decryptFieldSilent();
      if (val == null) {
        setError('Field not found');
      }
      return val;
    } catch {
      setError('Decryption failed -- try re-unlocking');
      return null;
    } finally {
      setDecrypting(false);
    }
  }, [decryptFieldSilent, revealedValue]);

  const handleCopySensitive = useCallback(async () => {
    if (decrypting) return;
    setMenuOpen(false);
    const val = await decryptFieldSilent();
    if (val != null) {
      navigator.clipboard.writeText(val);
      markCopied();
    }
  }, [decryptFieldSilent, decrypting, markCopied]);

  const handleReveal = useCallback(async () => {
    if (decrypting || (revealed && revealedValue != null)) return;
    setMenuOpen(false);
    const val = await decryptField();
    if (val != null) {
      revealForWindow(val);
    }
  }, [decryptField, decrypting, revealForWindow, revealed, revealedValue]);

  const handleHide = useCallback(() => {
    setRevealed(false);
    setRevealedValue(null);
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
  }, []);

  const handleLargeType = useCallback(async () => {
    setMenuOpen(false);
    const val = await decryptFieldSilent();
    if (val != null) {
      onShowLargeType(val);
    }
  }, [decryptFieldSilent, onShowLargeType]);

  const handleCopyNonSensitive = useCallback(() => {
    const valueToCopy = copyValue ?? value;
    if (valueToCopy) {
      navigator.clipboard.writeText(valueToCopy);
      markCopied();
    }
  }, [copyValue, value, markCopied]);

  const handleLargeTypeNonSensitive = useCallback(() => {
    if (!value) return;
    setMenuOpen(false);
    onShowLargeType(value);
  }, [onShowLargeType, value]);

  const isAnchorClick = useCallback((target: EventTarget | null): boolean => {
    return target instanceof Element && target.closest('a') !== null;
  }, []);

  const handleClickCopySensitive = useCallback(async () => {
    if (!isHoverCopyMode || decrypting) return;
    let val = revealedValue;
    if (val == null) {
      val = await decryptField();
      if (val != null) setRevealedValue(val);
    }
    if (val != null) {
      if (isRowHoverCopyMode) revealForWindow(val);
      navigator.clipboard.writeText(val);
      markCopied();
    }
  }, [decryptField, decrypting, isHoverCopyMode, isRowHoverCopyMode, markCopied, revealForWindow, revealedValue]);

  const handleSensitiveContentClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isRowHoverCopyMode || isSensitiveClickCopyMode) return;
    event.stopPropagation();
    if (isHoverCopyMode) {
      void handleClickCopySensitive();
      return;
    }
    void handleReveal();
  }, [
    handleClickCopySensitive,
    handleReveal,
    isHoverCopyMode,
    isRowHoverCopyMode,
    isSensitiveClickCopyMode,
  ]);

  if (!isSensitive) {
    const actions = (
      <div className="shrink-0 relative flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleCopyNonSensitive();
          }}
          className="inline-flex w-[56px] justify-start items-center gap-1 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-faint,#9ca3af)] hover:text-[var(--color-text,#0a0a0a)]"
        >
          <Copy size={10} />
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          ref={menuAnchorRef}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(!menuOpen);
          }}
          className="p-1 opacity-0 group-hover:opacity-100 transition-opacity text-[var(--color-text-faint,#9ca3af)] hover:text-[var(--color-text,#0a0a0a)]"
          aria-label={`Field actions for ${label}`}
        >
          <ChevronDown size={12} />
        </button>
        <Popover
          isOpen={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorEl={menuAnchorRef.current}
          anchor="right"
        >
          <div className="flex flex-col gap-1 min-w-[160px]">
            <button
              onClick={handleCopyNonSensitive}
              className="flex items-center gap-2 px-2 py-1.5 text-left font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors"
            >
              <Copy size={10} />
              Copy
            </button>
            <button
              onClick={handleLargeTypeNonSensitive}
              disabled={!value || disableLargeType}
              className="flex items-center gap-2 px-2 py-1.5 text-left font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors disabled:opacity-40"
            >
              <Maximize2 size={10} />
              Show in large type
            </button>
          </div>
        </Popover>
      </div>
    );

    if (renderMarkdown && value) {
      return (
        <div
          className="flex flex-wrap lg:flex-nowrap gap-x-3 gap-y-1 py-2 px-2 cursor-pointer hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors group items-start"
          onClick={(event) => {
            if (isAnchorClick(event.target)) return;
            handleCopyNonSensitive();
          }}
        >
          {actionsPosition === 'left' && actions}
          <div className="w-24 shrink-0">
            <span className="font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
              {copied ? 'Copied' : label}
            </span>
          </div>
          <div className="basis-full lg:basis-auto lg:flex-1 min-w-0 prose-mono max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" dangerouslySetInnerHTML={{ __html: plainMarkdownHtml }} />
          {actionsPosition === 'right' && actions}
        </div>
      );
    }

    return (
      <div
        className="flex flex-wrap lg:flex-nowrap items-center gap-x-3 gap-y-1 py-2 px-2 cursor-pointer hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors group"
        onClick={handleCopyNonSensitive}
      >
        {actionsPosition === 'left' && actions}
        <div className="w-24 shrink-0">
          <span className="font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
            {label}
          </span>
        </div>
        <div className="basis-full lg:basis-auto lg:flex-1 min-w-0 min-h-[24px] flex items-center">
          <span className="block min-w-0 font-mono text-[11px] text-[var(--color-text,#0a0a0a)] truncate whitespace-nowrap">
            {copied ? 'Copied' : (value || '--')}
          </span>
          {trailingValue}
        </div>
        {actionsPosition === 'right' && actions}
      </div>
    );
  }

  const sensitiveActions = canShowSensitiveActions ? (
    <div className="shrink-0 relative flex items-center gap-1">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void handleCopySensitive();
        }}
        className="inline-flex w-[56px] justify-start items-center gap-1 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-faint,#9ca3af)] hover:text-[var(--color-text,#0a0a0a)]"
      >
        <Copy size={10} />
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button
        ref={menuAnchorRef}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
        }}
        className="p-1 opacity-0 group-hover:opacity-100 transition-opacity text-[var(--color-text-faint,#9ca3af)] hover:text-[var(--color-text,#0a0a0a)]"
        aria-label={`Field actions for ${label}`}
      >
        <ChevronDown size={12} />
      </button>
      <Popover
        isOpen={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorEl={menuAnchorRef.current}
        anchor="right"
      >
        <div className="flex flex-col gap-1 min-w-[170px]">
          <button
            onClick={handleCopySensitive}
            className="flex items-center gap-2 px-2 py-1.5 text-left font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors"
          >
            <Copy size={10} />
            Copy
          </button>
          {!isHoverCopyMode && !revealed && (
            <button
              onClick={handleReveal}
              className="flex items-center gap-2 px-2 py-1.5 text-left font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors"
            >
              <Eye size={10} />
              Reveal
            </button>
          )}
          {!isHoverCopyMode && revealed && (
            <button
              onClick={handleHide}
              className="flex items-center gap-2 px-2 py-1.5 text-left font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors"
            >
              <EyeOff size={10} />
              Hide
            </button>
          )}
          {!disableLargeType && (
            <button
              onClick={handleLargeType}
              className="flex items-center gap-2 px-2 py-1.5 text-left font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors"
            >
              <Maximize2 size={10} />
              Show in large type
            </button>
          )}
        </div>
      </Popover>
    </div>
  ) : null;

  if (isMarkdownMode) {
    const handleMarkdownClick = (event: React.MouseEvent<HTMLDivElement>) => {
      if (isAnchorClick(event.target)) return;
      if (revealed && revealedValue != null) {
        void handleCopySensitive();
      } else {
        void handleReveal();
      }
    };

    const markdownActions = (
      <div className="shrink-0 relative flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleCopySensitive();
          }}
          className="inline-flex w-[56px] justify-start items-center gap-1 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-faint,#9ca3af)] hover:text-[var(--color-text,#0a0a0a)]"
        >
          <Copy size={10} />
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          ref={menuAnchorRef}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(!menuOpen);
          }}
          className="p-1 opacity-0 group-hover:opacity-100 transition-opacity text-[var(--color-text-faint,#9ca3af)] hover:text-[var(--color-text,#0a0a0a)]"
          aria-label={`Field actions for ${label}`}
        >
          <ChevronDown size={12} />
        </button>
        <Popover
          isOpen={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorEl={menuAnchorRef.current}
          anchor="right"
        >
          <div className="flex flex-col gap-1 min-w-[170px]">
            <button
              onClick={handleCopySensitive}
              className="flex items-center gap-2 px-2 py-1.5 text-left font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors"
            >
              <Copy size={10} />
              Copy
            </button>
            {!revealed ? (
              <button
                onClick={handleReveal}
                className="flex items-center gap-2 px-2 py-1.5 text-left font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors"
              >
                <Eye size={10} />
                Reveal
              </button>
            ) : (
              <button
                onClick={handleHide}
                className="flex items-center gap-2 px-2 py-1.5 text-left font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors"
              >
                <EyeOff size={10} />
                Hide
              </button>
            )}
          </div>
        </Popover>
      </div>
    );

    return (
      <div
        data-testid={`credential-field-row-${fieldKey}`}
        className="flex flex-wrap lg:flex-nowrap gap-x-3 gap-y-1 py-2 px-2 group transition-colors cursor-pointer hover:bg-[var(--color-background-alt,#f4f4f5)] items-start"
        onClick={handleMarkdownClick}
      >
        {actionsPosition === 'left' && markdownActions}
        <div className="w-24 shrink-0">
          <span className="font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
            {copied ? 'Copied' : label}
          </span>
        </div>
        <div
          data-testid={`credential-field-value-${fieldKey}`}
          className="basis-full lg:basis-auto lg:flex-1 min-w-0"
        >
          {error ? (
            <span className="font-mono text-[10px] text-[var(--color-danger,#ef4444)]">{error}</span>
          ) : decrypting ? (
            <Loader2 size={12} className="animate-spin text-[var(--color-text-muted,#6b7280)]" />
          ) : revealed && revealedValue != null ? (
            <div className="prose-mono max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
          ) : (
            <span className="font-mono text-[11px] text-[var(--color-text-muted,#6b7280)] tracking-wider">
              {'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
            </span>
          )}
        </div>
        {actionsPosition === 'right' && markdownActions}
      </div>
    );
  }

  return (
    <div
      data-testid={`credential-field-row-${fieldKey}`}
      className={`flex flex-wrap lg:flex-nowrap gap-x-3 gap-y-1 py-2 px-2 group transition-colors rounded-sm items-center ${(isRowHoverCopyMode || isSensitiveClickCopyMode) ? 'cursor-pointer hover:bg-[var(--color-background-alt,#f4f4f5)]' : ''}`}
      onClick={() => {
        if (isRowHoverCopyMode) {
          void handleClickCopySensitive();
          return;
        }
        if (isSensitiveClickCopyMode) void handleCopySensitive();
      }}
    >
      {actionsPosition === 'left' && sensitiveActions}
      <div className="w-24 shrink-0">
        <span className="font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
          {label}
        </span>
      </div>
      <div
        data-testid={`credential-field-value-${fieldKey}`}
        className={`basis-full lg:basis-auto lg:flex-1 min-w-0 transition-colors rounded-sm ${isHoverCopyMode ? '' : 'cursor-pointer'} ${`${(isRowHoverCopyMode || isSensitiveClickCopyMode) ? 'min-h-[24px] flex items-center' : 'hover:bg-[var(--color-background-alt,#f4f4f5)] min-h-[24px] flex items-center'} px-1 py-0.5`}`}
        onClick={handleSensitiveContentClick}
      >
        {error ? (
          <span className="font-mono text-[10px] text-[var(--color-danger,#ef4444)]">{error}</span>
        ) : decrypting ? (
          <Loader2 size={12} className="animate-spin text-[var(--color-text-muted,#6b7280)]" />
        ) : isRowHoverCopyMode ? (
          revealed && revealedValue != null ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="block min-w-0 font-mono text-[11px] text-[var(--color-text,#0a0a0a)] truncate whitespace-nowrap">{revealedValue}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleHide();
                }}
                className="shrink-0 text-[var(--color-text-faint,#9ca3af)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
              >
                <EyeOff size={12} />
              </button>
            </div>
          ) : (
            <div className="w-full">
              <div
                data-testid={`credential-field-barcode-${fieldKey}`}
                className="h-4 w-full bg-[repeating-linear-gradient(90deg,var(--color-text,#000),var(--color-text,#000)_1px,transparent_1px,transparent_3px)] opacity-30"
              />
              <div
                className="mt-1 h-1.5 w-full"
                style={{
                  backgroundImage: 'repeating-linear-gradient(45deg, var(--color-text, #000), var(--color-text, #000) 5px, transparent 5px, transparent 10px)',
                  opacity: 0.1,
                }}
              />
              <div className="mt-1 font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] tracking-wider uppercase">
                {copied ? 'Copied' : 'Click to reveal and copy'}
              </div>
            </div>
          )
        ) : isHoverCopyMode ? (
          <span className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)] tracking-wider uppercase">
            {copied ? 'Copied' : revealedValue != null ? 'Hover then click to copy' : 'Decrypting'}
          </span>
        ) : revealed && revealedValue != null ? (
          <div className="flex items-center gap-2 min-w-0">
            <span className="block min-w-0 font-mono text-[11px] text-[var(--color-text,#0a0a0a)] truncate whitespace-nowrap">{revealedValue}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleHide();
              }}
              className="shrink-0 text-[var(--color-text-faint,#9ca3af)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
            >
              <EyeOff size={12} />
            </button>
          </div>
        ) : (
          <span className="font-mono text-[11px] text-[var(--color-text-muted,#6b7280)] tracking-wider">
            {copied ? 'Copied' : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
          </span>
        )}
      </div>
      {actionsPosition === 'right' && sensitiveActions}
    </div>
  );
};
