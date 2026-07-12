'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus, Search } from 'lucide-react';

// ─── Agent Profile Picture ───────────────────────────────────────────

/** Strip aurawallet.sh domain to use local /public sprite assets */
function localPfpUrl(url: string): string {
  return url.replace(/^https?:\/\/auramaxx\.sh/, '');
}

/**
 * Generic agent profile picture.
 * Renders a CSS sprite sheet animation when `isSprite` is true,
 * a regular `<img>` for static images, or a letter fallback.
 */
export function AgentPfp({
  src,
  isSprite,
  fallbackLetter,
  size = 'sm',
}: {
  src?: string;
  isSprite?: boolean;
  fallbackLetter?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const spriteDims = size === 'lg'
    ? { width: '32px', height: '48px' }
    : size === 'md'
      ? { width: '22px', height: '33px' }
      : { width: '14px', height: '21px' };

  const imgDims = size === 'lg' ? 'w-8 h-8' : size === 'md' ? 'w-6 h-6' : 'w-4 h-4';
  const fallbackDims = size === 'lg' ? 'w-8 h-8 text-[10px]' : size === 'md' ? 'w-5 h-5 text-[8px]' : 'w-4 h-4 text-[7px]';

  if (src && isSprite) {
    return (
      <div
        className="shrink-0"
        style={{
          backgroundImage: `url('${localPfpUrl(src)}')`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: '300% 300%',
          backgroundPositionY: '0',
          imageRendering: 'pixelated' as const,
          animation: 'yo-sprite-frames 0.9s steps(1, end) infinite',
          ...spriteDims,
        }}
      />
    );
  }

  if (src) {
    return (
      <img
        src={localPfpUrl(src)}
        alt=""
        className={`${imgDims} shrink-0 object-cover border border-[var(--color-border,#d4d4d8)]`}
        style={{ imageRendering: 'auto' }}
      />
    );
  }

  return (
    <div className={`${fallbackDims} shrink-0 border border-dashed border-[var(--color-border,#d4d4d8)] flex items-center justify-center uppercase text-[var(--color-text-faint,#9ca3af)] font-mono`}>
      {(fallbackLetter || '?').slice(0, 1)}
    </div>
  );
}

// ─── Agent Picker ────────────────────────────────────────────────────

export interface AgentPickerProfile {
  displayName?: string;
  handle?: string;
  pfp?: string;
  pfpIsSprite?: boolean;
}

export interface AgentPickerAgent {
  id: string;
  name?: string;
  isPrimary?: boolean;
}

export function AgentPicker({
  agents,
  profiles,
  selectedId,
  onSelect,
  onCreateAgent,
  direction = 'down',
}: {
  agents: AgentPickerAgent[];
  profiles: Record<string, AgentPickerProfile>;
  selectedId: string | null;
  onSelect: (agentId: string) => void;
  onCreateAgent?: () => void;
  direction?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedAgent = agents.find(a => a.id === selectedId);
  const p = selectedId ? profiles[selectedId] : undefined;
  const displayName = p?.displayName || selectedAgent?.name
    || (selectedAgent?.isPrimary ? 'Primary' : selectedId?.slice(0, 8) || 'Select');
  const handle = p?.handle
    ? (p.handle.startsWith('@') ? p.handle : `@${p.handle}`)
    : null;

  // Close on outside click / ESC
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Focus search on open
  useEffect(() => {
    if (open) {
      setSearch('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const isSearching = search.trim().length > 0;
  const matched = isSearching
    ? agents.filter(a => {
        const q = search.toLowerCase();
        const prof = profiles[a.id];
        return (prof?.displayName?.toLowerCase().includes(q))
          || (prof?.handle?.toLowerCase().includes(q))
          || (a.name?.toLowerCase().includes(q))
          || a.id.toLowerCase().includes(q);
      })
    : agents.slice(0, 10); // show 10 most recent by default, search for the rest

  const dropdownPos = direction === 'up'
    ? { bottom: '100%', marginBottom: '4px' } as const
    : { top: '100%', marginTop: '4px' } as const;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* Trigger */}
      <div className="w-full flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex-1 flex items-center gap-2.5 font-mono text-left transition-all"
          style={{
            padding: '8px 10px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          <AgentPfp
            src={p?.pfp}
            isSprite={p?.pfpIsSprite}
            fallbackLetter={selectedAgent?.name || 'A'}
            size="md"
          />
          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
            <div className="text-[10px] font-bold tracking-tight text-[var(--color-text,#0a0a0a)] truncate">
              {displayName}
            </div>
            {handle && (
              <div className="text-[8px] text-[var(--color-text-muted,#6b7280)] truncate">
                {handle}
              </div>
            )}
          </div>
          <ChevronDown
            size={10}
            className="shrink-0 text-[var(--color-text-muted,#6b7280)]"
            style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }}
          />
        </button>
        {onCreateAgent && (
          <button
            type="button"
            onClick={onCreateAgent}
            className="shrink-0 flex items-center justify-center text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}
            title="New agent"
          >
            <Plus size={12} />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute z-50 left-0 right-0 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)] shadow-mech font-mono"
          style={{ maxHeight: '240px', display: 'flex', flexDirection: 'column', ...dropdownPos }}
        >
          {/* Search */}
          <div className="p-1.5 border-b border-dashed border-[var(--color-border,#d4d4d8)]">
            <div className="flex items-center gap-1.5 px-2 py-1 bg-[var(--color-bg,#fafaf9)] border border-[var(--color-border,#d4d4d8)]">
              <Search size={10} className="shrink-0 text-[var(--color-text-faint,#9ca3af)]" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search agents..."
                className="flex-1 bg-transparent text-[9px] outline-none text-[var(--color-text,#0a0a0a)] placeholder-[var(--color-text-faint,#9ca3af)] font-mono"
              />
            </div>
          </div>

          {/* Agent list */}
          <div className="overflow-y-auto flex-1" style={{ maxHeight: '180px' }}>
            {matched.length === 0 ? (
              <div className="px-3 py-4 text-center text-[8px] uppercase tracking-widest text-[var(--color-text-faint,#9ca3af)]">
                No agents found
              </div>
            ) : (
              matched.map((agent) => {
                const prof = profiles[agent.id];
                const isActive = agent.id === selectedId;
                const name = prof?.displayName || agent.name || (agent.isPrimary ? 'Primary' : agent.id.slice(0, 8));
                const h = prof?.handle ? (prof.handle.startsWith('@') ? prof.handle : `@${prof.handle}`) : null;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => { onSelect(agent.id); setOpen(false); }}
                    className={`w-full flex items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-[var(--color-background-alt,#f4f4f5)] ${isActive ? 'bg-[var(--color-background-alt,#f4f4f5)]' : ''}`}
                    style={{ borderLeft: isActive ? '2px solid var(--color-accent, #6366f1)' : '2px solid transparent' }}
                  >
                    <AgentPfp
                      src={prof?.pfp}
                      isSprite={prof?.pfpIsSprite}
                      fallbackLetter={agent.name || 'A'}
                      size="sm"
                    />
                    <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                      <div className="text-[9px] font-bold tracking-tight text-[var(--color-text,#0a0a0a)] truncate">
                        {name}
                      </div>
                      {h && (
                        <div className="text-[7px] text-[var(--color-text-muted,#6b7280)] truncate">
                          {h}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
            {!isSearching && agents.length > 10 && (
              <div className="px-3 py-1.5 text-center text-[7px] uppercase tracking-widest text-[var(--color-text-faint,#9ca3af)] border-t border-dashed border-[var(--color-border,#d4d4d8)]">
                {agents.length - 10} more — type to search
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
