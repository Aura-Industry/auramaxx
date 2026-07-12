'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface FilterDropdownProps {
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  compact?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  menuPosition?: 'auto' | 'top' | 'bottom';
}

export const FilterDropdown: React.FC<FilterDropdownProps> = ({
  options,
  value,
  onChange,
  label,
  compact = false,
  disabled = false,
  ariaLabel,
  searchable = false,
  searchPlaceholder = 'Search...',
  emptyMessage = 'No options found',
  menuPosition = 'auto',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState(192);
  const [searchQuery, setSearchQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedOption = options.find(opt => opt.value === value);

  const filteredOptions = useMemo(() => {
    if (!searchable) return options;
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => (
      option.label.toLowerCase().includes(needle)
      || option.value.toLowerCase().includes(needle)
    ));
  }, [options, searchQuery, searchable]);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      return;
    }
    if (searchable) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [isOpen, searchable]);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    const scale = Number.parseFloat(
      window.getComputedStyle(document.documentElement).getPropertyValue('--ui-scale-factor'),
    ) || 1;
    if (rect) {
      const viewportPadding = Math.round(12 * scale);
      const desiredHeight = Math.round(192 * scale);
      const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding);
      const spaceAbove = Math.max(0, rect.top - viewportPadding);
      const shouldOpenUpward = menuPosition === 'top'
        ? true
        : menuPosition === 'bottom'
          ? false
          : spaceBelow < desiredHeight && spaceAbove > spaceBelow;
      const available = shouldOpenUpward ? spaceAbove : spaceBelow;
      setOpenUpward(shouldOpenUpward);
      setMenuMaxHeight(Math.max(0, Math.floor(Math.min(desiredHeight, available))));
    } else {
      setOpenUpward(menuPosition === 'top');
      setMenuMaxHeight(Math.round(192 * scale));
    }
    setIsOpen(true);
  };

  return (
    <div className={`relative w-full group ${isOpen ? 'z-50' : 'z-20'}`}>
      {label && (
        <label className="block text-[length:var(--font-size-xs)] font-mono font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] mb-[var(--space-1)] px-[var(--space-1)] pointer-events-none">
          {label}
        </label>
      )}
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (isOpen) {
            setIsOpen(false);
            return;
          }
          openMenu();
        }}
        className={`
            w-full ${compact ? 'h-[var(--control-height-sm)] text-[length:var(--font-size-xs)]' : 'h-[calc(var(--control-height-lg)+var(--space-2))] text-[length:var(--font-size-md)]'} flex items-center justify-between px-[var(--space-3)] outline-none
            bg-[var(--color-background-alt,#f4f4f5)] border font-mono font-bold tracking-wider text-[var(--color-text,#0a0a0a)]
            transition-all duration-200
            ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
            ${isOpen
            ? 'border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-surface,#ffffff)] shadow-[0_0_0_1px_var(--color-border-muted,#a1a1aa)]'
            : 'border-[var(--color-border,#d4d4d8)] hover:border-[var(--color-border-muted,#a1a1aa)] hover:bg-[var(--color-surface,#ffffff)]'
          }
        `}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selectedOption?.label || 'SELECT'}</span>
        <ChevronDown
          className={`shrink-0 transform transition-transform text-[var(--color-text-muted,#6b7280)] group-hover:text-[var(--color-text,#0a0a0a)] ${isOpen ? 'rotate-180 text-[var(--color-text,#0a0a0a)]' : ''}`}
          style={{ width: 'var(--font-size-md)', height: 'var(--font-size-md)' }}
        />
      </button>

      {isOpen && !disabled && (
        <>
          <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-border-focus,#0a0a0a)] pointer-events-none z-30" />
          <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-border-focus,#0a0a0a)] pointer-events-none z-30" />
        </>
      )}

      {isOpen && !disabled && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div
            className={`absolute left-0 w-full bg-[var(--color-surface,#ffffff)] border border-[var(--color-border-focus,#0a0a0a)] shadow-[0_0_0_1px_var(--color-border-muted,#a1a1aa)] overflow-y-auto z-50 ${openUpward ? 'bottom-full mb-[var(--space-1)]' : 'top-full mt-[var(--space-1)]'}`}
            style={{ maxHeight: `${menuMaxHeight}px` }}
          >
            {searchable && (
              <div className="sticky top-0 bg-[var(--color-surface,#ffffff)] border-b border-[var(--color-border-muted,#e5e5e5)] p-[var(--space-2)]">
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  className="w-full h-[var(--control-height-sm)] px-[var(--space-2)] border border-[var(--color-border,#d4d4d8)] font-mono text-[length:var(--font-size-xs)] text-[var(--color-text,#0a0a0a)] bg-[var(--color-background-alt,#f4f4f5)] focus:outline-none focus:border-[var(--color-border-focus,#0a0a0a)]"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setIsOpen(false);
                    }
                  }}
                />
              </div>
            )}

            {filteredOptions.length === 0 ? (
              <div className="px-[var(--space-3)] py-[var(--space-3)] text-[var(--color-text-faint,#9ca3af)] font-mono text-[length:var(--font-size-xs)]">
                {emptyMessage}
              </div>
            ) : (
              filteredOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setIsOpen(false);
                  }}
                  className={`w-full text-left px-[var(--space-3)] py-[var(--space-2)] text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] font-mono ${compact ? 'text-[length:var(--font-size-xs)]' : 'text-[length:var(--font-size-sm)]'} border-b border-[var(--color-border-muted,#e5e5e5)] last:border-0 flex items-center gap-[var(--space-2)] group/item`}
                >
                  <div className={`w-1.5 h-1.5 flex-shrink-0 ${opt.value === value ? 'bg-[var(--color-text,#0a0a0a)]' : 'bg-[var(--color-border,#d4d4d8)] group-hover/item:bg-[var(--color-text,#0a0a0a)]'}`} />
                  <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
};
