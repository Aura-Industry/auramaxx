'use client';

import { useState } from 'react';

interface ShareUrlButtonProps {
  url: string;
}

export default function ShareUrlButton({ url }: ShareUrlButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
      aria-label="Copy share URL"
      data-testid="header-share-button"
    >
      {copied ? 'COPIED' : 'SHARE'}
    </button>
  );
}
