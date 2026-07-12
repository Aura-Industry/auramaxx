'use client';

import React from 'react';
import { ChevronDown } from 'lucide-react';

interface TyvekCollapsibleSectionProps {
  title: string;
  icon?: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  tone?: 'default' | 'warning';
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
}

export const TyvekCollapsibleSection: React.FC<TyvekCollapsibleSectionProps> = ({
  title,
  icon,
  isOpen,
  onToggle,
  children,
  tone = 'default',
  className = '',
  headerClassName = '',
  contentClassName = '',
}) => {
  const toneClass = tone === 'warning' ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)]';

  return (
    <div className={`bg-[var(--color-surface)] border-mech clip-specimen-sm shadow-mech !rounded-none ${className}`}>
      <button
        type="button"
        onClick={onToggle}
        className={`w-full flex items-center justify-between px-4 py-3 bg-transparent hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors ${headerClassName}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {icon ? <span className={toneClass}>{icon}</span> : null}
          <span className={`font-mono text-[9px] font-semibold tracking-widest uppercase ${toneClass}`}>{title}</span>
        </div>
        <ChevronDown
          size={12}
          className={`${toneClass} transition-transform flex-shrink-0 ml-2 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div className={contentClassName}>
          {children}
        </div>
      )}
    </div>
  );
};
