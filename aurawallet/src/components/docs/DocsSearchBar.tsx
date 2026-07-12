'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

interface DocsSearchBarProps {
  initialQuery?: string;
}

export default function DocsSearchBar({ initialQuery = '' }: DocsSearchBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const currentQuery = searchParams.get('query') ?? searchParams.get('q') ?? '';

  const [value, setValue] = useState(() => currentQuery || initialQuery);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingQueryRef = useRef<string | null>(null);
  const lastTypedValueRef = useRef<string>(currentQuery || initialQuery);

  useEffect(() => {
    if (pendingQueryRef.current !== null) {
      if (currentQuery === pendingQueryRef.current) {
        const appliedPendingValue = pendingQueryRef.current;
        pendingQueryRef.current = null;
        if (lastTypedValueRef.current !== appliedPendingValue) {
          return;
        }
      } else {
        return;
      }
    }

    lastTypedValueRef.current = currentQuery;
    setValue((previous) => (previous === currentQuery ? previous : currentQuery));
  }, [currentQuery]);

  const replaceQueryInUrl = useCallback((nextQuery: string) => {
    const nextParams = new URLSearchParams(searchParamsString);
    nextParams.delete('q');
    nextParams.delete('query');
    if (nextQuery) nextParams.set('query', nextQuery);
    const next = nextParams.toString();
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [pathname, router, searchParamsString]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (value === currentQuery) return;

    const nextValue = value;
    const timeout = window.setTimeout(() => {
      pendingQueryRef.current = nextValue;
      replaceQueryInUrl(nextValue);
    }, 180);

    return () => window.clearTimeout(timeout);
  }, [value, currentQuery, replaceQueryInUrl]);

  return (
    <div className="fixed bottom-4 left-1/2 z-40 w-[min(760px,calc(100%-2rem))] -translate-x-1/2">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          pendingQueryRef.current = value;
          replaceQueryInUrl(value);
        }}
        className="border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#f4f4f2)] shadow-lg px-3 py-2 flex items-center gap-2 font-mono"
      >
        <label htmlFor="docs-search" className="text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] shrink-0">
          Search
        </label>
        <input
          ref={inputRef}
          id="docs-search"
          name="query"
          type="search"
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value;
            lastTypedValueRef.current = nextValue;
            setValue(nextValue);
          }}
          placeholder="Search docs by title, file, or summary"
          className="flex-1 min-w-0 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)] px-2 py-1 text-[11px] text-[var(--color-text,#0a0a0a)] outline-none focus:border-[var(--color-text,#0a0a0a)]"
        />
        {value.trim() ? (
          <button
            type="button"
            onClick={() => {
              lastTypedValueRef.current = '';
              setValue('');
            }}
            className="px-2 py-1 text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
          >
            Clear
          </button>
        ) : (
          <span className="px-2 py-1 text-[9px] tracking-widest uppercase text-[var(--color-text-faint,#9ca3af)]">
            Cmd/Ctrl+K
          </span>
        )}
      </form>
    </div>
  );
}
