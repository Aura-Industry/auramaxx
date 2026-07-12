'use client';

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';

interface PersistentDocGroupProps {
  storageKey: string;
  label: string;
  forceOpen?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}

const OPEN_VALUE = '1';
const CLOSED_VALUE = '0';

export default function PersistentDocGroup({
  storageKey,
  label,
  forceOpen = false,
  defaultOpen = false,
  children,
}: PersistentDocGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [hydrated, setHydrated] = useState(false);

  // Read saved state from localStorage before paint (avoids flash).
  useLayoutEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === OPEN_VALUE) setIsOpen(true);
      else if (stored === CLOSED_VALUE) setIsOpen(false);
    } catch {
      // localStorage may be blocked; keep default.
    }
    setHydrated(true);
  }, [storageKey]);

  // Persist changes to localStorage only after the initial read.
  useEffect(() => {
    if (!hydrated || forceOpen) return;
    try {
      window.localStorage.setItem(storageKey, isOpen ? OPEN_VALUE : CLOSED_VALUE);
    } catch {
      // Ignore persistence errors.
    }
  }, [hydrated, forceOpen, isOpen, storageKey]);

  const open = forceOpen || isOpen;

  // Use onClick + preventDefault instead of onToggle to avoid the
  // React/details toggle race condition during navigation reconciliation.
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!forceOpen) setIsOpen((prev) => !prev);
    },
    [forceOpen],
  );

  return (
    <details
      className="group"
      open={open}
      suppressHydrationWarning
    >
      <summary
        className="list-none cursor-pointer px-1 py-0.5 flex items-center justify-between text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase hover:text-[var(--color-text,#0a0a0a)] transition-colors [&::-webkit-details-marker]:hidden"
        onClick={handleClick}
      >
        <span>{label}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>
      <div className="mt-1 space-y-0.5">
        {children}
      </div>
    </details>
  );
}
