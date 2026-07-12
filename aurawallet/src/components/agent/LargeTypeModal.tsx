'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Modal, Button } from '@/components/design-system';

interface LargeTypeModalProps {
  isOpen: boolean;
  onClose: () => void;
  value: string;
}

export const LargeTypeModal: React.FC<LargeTypeModalProps> = ({ isOpen, onClose, value }) => {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const characters = Array.from(value ?? '');

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard might be unavailable in some contexts.
    }
  }, [value]);

  useEffect(() => {
    if (!isOpen) setCopied(false);
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, [isOpen]);

  const renderCharacter = (char: string): string => {
    if (char === ' ') return '␠';
    if (char === '\n') return '↵';
    if (char === '\t') return '⇥';
    return char;
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Expanded Value"
      size="lg"
      contentClassName="!p-0"
      footer={(
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => { void handleCopy(); }}>
            {copied ? 'COPIED' : 'COPY'}
          </Button>
        </div>
      )}
    >
      <div className="w-full min-h-[360px] px-6 py-8 flex flex-col items-center justify-center text-center">
        <div className="w-full max-w-[900px] max-h-[70vh] overflow-auto px-1">
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(56px,1fr))]">
            {characters.map((char, index) => (
              <div
                key={`${index}-${char}`}
                data-testid={`large-type-char-${index + 1}`}
                className="rounded-sm border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)] px-1 py-2"
              >
                <div className="font-mono text-3xl font-bold leading-none text-[var(--color-text,#0a0a0a)] select-all">
                  {renderCharacter(char)}
                </div>
                <div
                  data-testid={`large-type-index-${index + 1}`}
                  className="mt-2 font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-faint,#9ca3af)]"
                >
                  {index + 1}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-8 font-mono text-[9px] tracking-widest uppercase text-[var(--color-text-faint,#9ca3af)]">
          Use copy to move this value to clipboard
        </div>
      </div>
    </Modal>
  );
};
