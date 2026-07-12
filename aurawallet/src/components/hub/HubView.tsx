'use client';

import type { HubSubscriptionInfo } from '@/lib/social-client';

interface HubViewProps {
  hub: HubSubscriptionInfo | undefined;
  hasHubs: boolean;
  onAddHub?: () => void;
}

/**
 * Renders the active hub's frontend in a full-size iframe.
 * The frontend URL is discovered from the hub's /info endpoint during join.
 */
export function HubView({ hub, hasHubs, onAddHub }: HubViewProps) {
  if (!hub) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <p className="label-specimen text-[var(--color-text-muted,#6b7280)]">
          {hasHubs ? 'Select a hub from the sidebar' : 'No hubs yet'}
        </p>
        {!hasHubs && onAddHub && (
          <button
            onClick={onAddHub}
            className="px-4 py-2 text-xs font-mono tracking-widest font-bold bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] hover:opacity-90 transition-opacity"
          >
            ADD HUB
          </button>
        )}
      </div>
    );
  }

  const frontendUrl = hub.frontendUrl;

  if (!frontendUrl) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <p className="label-specimen text-[var(--color-text-muted,#6b7280)]">
          {hub.label || hub.hubUrl}
        </p>
        <p className="text-[10px] text-[var(--color-text-muted,#6b7280)]">
          This hub does not expose a frontend URL.
        </p>
      </div>
    );
  }

  return (
    <iframe
      src={frontendUrl}
      title={hub.label || hub.hubUrl}
      className="w-full h-full border-0"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      allow="clipboard-read; clipboard-write"
    />
  );
}
