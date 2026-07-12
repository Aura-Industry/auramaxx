'use client';

import React from 'react';
import { Search } from 'lucide-react';
import { TextInput } from '@/components/design-system';

// ─── Types ───────────────────────────────────────────────────────────

interface ViewShellProps {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  sidebarFooter?: React.ReactNode;
  contentClassName?: string;
}

// ─── ViewShell ───────────────────────────────────────────────────────

export function ViewShell({
  sidebar,
  children,
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search...',
  sidebarFooter,
  contentClassName,
}: ViewShellProps) {
  const sidebarWidth = 'calc(200px * var(--ui-scale-factor, 1))';

  return (
    <div className="relative isolate h-full w-full overflow-hidden flex flex-col bg-[var(--color-background,#f4f4f5)]">
      {/* Background — sterile tyvek field */}
      <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute inset-0 bg-grid-adaptive bg-[size:4rem_4rem] opacity-30" />
        <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />
        <div className="absolute bottom-[5%] right-[5%] opacity-[0.03] select-none">
          <div className="text-[12vw] font-black leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter text-right">
            AURAWALLET
          </div>
        </div>
        <div className="absolute top-10 left-[200px] w-24 h-24 border-l-4 border-t-4 border-[var(--color-text,#0a0a0a)] opacity-10">
          <div className="absolute top-2 left-2 w-3 h-3 bg-[var(--color-text,#0a0a0a)]" />
        </div>
        <div className="absolute bottom-10 right-10 w-24 h-24 border-r-4 border-b-4 border-[var(--color-text,#0a0a0a)] opacity-10 flex items-end justify-end">
          <div className="absolute bottom-2 right-2 w-3 h-3 bg-[var(--color-text,#0a0a0a)]" />
        </div>
      </div>

      {/* Main layout */}
      <div className="relative z-10 flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div
          className="h-full flex flex-col border-r border-[var(--color-border,#d4d4d8)] font-mono relative overflow-hidden shrink-0"
          style={{
            width: sidebarWidth,
            minWidth: sidebarWidth,
            background: 'var(--color-surface, #f4f4f2)',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          {/* Dot texture */}
          <div className="absolute inset-0 opacity-[0.02] pointer-events-none bg-[radial-gradient(var(--color-text,#000)_1px,transparent_1px)] bg-[size:4px_4px]" />

          {/* Branding header */}
          <div className="flex items-center justify-between border-b border-[var(--color-border,#d4d4d8)] relative z-10 px-3 py-3">
            <div className="flex items-center gap-2">
              <div className="leading-tight">
                <div className="flex items-baseline gap-1">
                  <span className="text-[10px] font-bold tracking-tight lowercase text-[var(--color-text,#0a0a0a)]">
                    aurawallet
                  </span>
                  <span className="text-[8px] text-[var(--color-text-muted,#6b7280)] uppercase tracking-widest">
                    from
                  </span>
                </div>
                <a
                  href="https://x.com/nicoletteduclar"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-[8px] text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
                >
                  @nicoletteduclar, with love
                </a>
              </div>
            </div>
          </div>

          {/* Scrollable sidebar content */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden relative z-10">
            {sidebar}
          </div>

          {/* Footer (e.g. auraId display) */}
          {sidebarFooter && (
            <div className="relative z-30 border-t border-[var(--color-border,#d4d4d8)] overflow-visible">
              {sidebarFooter}
            </div>
          )}
        </div>

        {/* Main content */}
        <div className={`flex-1 overflow-y-auto relative ${contentClassName || ''}`}>
          {children}
        </div>
      </div>

      {/* Search dock (bottom) */}
      {onSearchChange && (
        <div className="absolute bottom-0 left-[200px] right-0 z-30 border-t border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)]/95 backdrop-blur-sm">
          <div className="w-full px-3 py-2.5">
            <TextInput
              compact
              leftElement={<Search size={12} />}
              placeholder={searchPlaceholder}
              value={searchValue ?? ''}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
