'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Download } from 'lucide-react';

interface DownloadAsset {
  label: string;
  href: string;
}

interface DownloadButtonProps {
  /** Icon-only mode (e.g. for compact sidebars) */
  compact?: boolean;
}

/** Known public download assets — checked via HEAD on mount. */
const KNOWN_ASSETS: DownloadAsset[] = [
  { label: 'Mac', href: '/Aura-1.0.0-alpha.9-arm64.dmg' },
  { label: 'Windows', href: '/Aura Setup 1.0.0-alpha.9.exe' },
];

function isElectron(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as Record<string, unknown>).auraDesktop);
}

export const DownloadButton: React.FC<DownloadButtonProps> = ({ compact = false }) => {
  const [assets, setAssets] = useState<DownloadAsset[]>([]);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Probe which assets actually exist and hide on Electron
  useEffect(() => {
    setMounted(true);

    if (isElectron()) return; // already running the desktop app

    let cancelled = false;
    (async () => {
      const available: DownloadAsset[] = [];
      await Promise.all(
        KNOWN_ASSETS.map(async (asset) => {
          try {
            const res = await fetch(asset.href, { method: 'HEAD' });
            if (!cancelled && res.ok) available.push(asset);
          } catch {
            // asset not available
          }
        }),
      );
      if (!cancelled) {
        // preserve original order
        setAssets(KNOWN_ASSETS.filter((a) => available.includes(a)));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(target) &&
        triggerRef.current && !triggerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.right - 140 });
    }
    setOpen((prev) => !prev);
  };

  // Nothing to download → render nothing
  if (assets.length === 0) return null;

  return (
    <>
      {compact ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          className="flex items-center justify-center w-6 h-6 text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors"
          title="Download"
          aria-label="Download"
        >
          <Download size={10} />
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          className="flex items-center gap-1 px-1.5 py-1 text-[8px] font-mono font-bold tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
          title="Download"
          aria-expanded={open}
        >
          DOWNLOAD
          <ChevronDown size={8} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}

      {open && mounted && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div
            ref={menuRef}
            className="fixed w-[140px] bg-[var(--color-surface,#ffffff)] border border-[var(--color-border-focus,#0a0a0a)] shadow-mech z-[9999] font-mono"
            style={pos ? { top: pos.top, left: Math.max(4, pos.left) } : undefined}
          >
            {assets.map((asset, i) => (
              <a
                key={asset.href}
                href={asset.href}
                download
                className={`w-full flex items-center gap-2 px-3 py-2 text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors ${i < assets.length - 1 ? 'border-b border-[var(--color-border-muted,#e5e5e5)]' : ''}`}
                onClick={() => setOpen(false)}
              >
                <div className="w-1.5 h-1.5 bg-[var(--color-border,#d4d4d8)]" />
                {asset.label}
              </a>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
};
