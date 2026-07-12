'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface IFrameAppProps {
  config?: {
    url?: string;
    title?: string;
  };
}

/**
 * SECURITY: Iframe sandbox is hardcoded and NOT configurable by agents.
 * Using "allow-scripts allow-forms" WITHOUT allow-same-origin prevents the
 * embedded page from accessing the parent's cookies, localStorage, sessionStorage,
 * or making same-origin requests to the wallet server.
 *
 * allow-same-origin was intentionally removed -- combining allow-scripts + allow-same-origin
 * effectively negates the sandbox since the iframe can then access and modify the parent.
 */
const IFRAME_SANDBOX = 'allow-scripts allow-forms';

export default function IFrameApp({ config }: IFrameAppProps) {
  const url = config?.url;
  const title = config?.title || 'Embedded Content';

  if (!url) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-[var(--color-text-muted,#6b7280)]">
        <AlertTriangle size={24} className="mb-2" />
        <span className="font-mono text-xs">NO URL CONFIGURED</span>
      </div>
    );
  }

  // Validate URL - only allow http(s) schemes
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return (
        <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-[var(--color-error,#ff4d00)]">
          <AlertTriangle size={24} className="mb-2" />
          <span className="font-mono text-xs">BLOCKED URL SCHEME</span>
          <span className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)] mt-1">
            Only http/https URLs are allowed
          </span>
        </div>
      );
    }
  } catch {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-[var(--color-error,#ff4d00)]">
        <AlertTriangle size={24} className="mb-2" />
        <span className="font-mono text-xs">INVALID URL</span>
        <span className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)] mt-1 max-w-full truncate px-4">
          {url}
        </span>
      </div>
    );
  }

  return (
    <iframe
      src={url}
      title={title}
      sandbox={IFRAME_SANDBOX}
      className="w-full h-full border-0"
      style={{ minHeight: '200px' }}
      loading="lazy"
    />
  );
}
