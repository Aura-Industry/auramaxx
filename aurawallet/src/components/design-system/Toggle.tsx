'use client';

import React from 'react';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export const Toggle: React.FC<ToggleProps> = ({
  checked,
  onChange,
  label,
  disabled = false,
  size = 'md',
}) => {
  const compact = size === 'sm';
  const trackWidth = compact ? 'calc(var(--space-4) * 2)' : 'calc(var(--space-4) * 2 + var(--space-2))';
  const trackHeight = compact ? 'var(--space-4)' : 'calc(var(--space-4) + var(--space-1))';
  const knobSize = compact ? 'calc(var(--space-4) - var(--space-1))' : 'calc(var(--space-4) - 2px)';
  const knobTranslate = compact ? 'var(--space-4)' : 'calc(var(--space-4) + var(--space-1))';

  return (
    <label
      className={`flex items-center gap-[var(--space-2)] ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`
          rounded-full relative transition-colors duration-200 flex-shrink-0
          ${checked
            ? 'bg-[var(--color-accent,#ccff00)]'
            : 'bg-[var(--color-border,#d4d4d8)]'
          }
          ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
        `}
        style={{ width: trackWidth, height: trackHeight }}
      >
        <span
          className={`
            rounded-full absolute top-1/2 left-[2px]
            bg-[var(--color-text,#0a0a0a)] transition-transform duration-200
          `}
          style={{
            width: knobSize,
            height: knobSize,
            transform: checked ? `translate(${knobTranslate}, -50%)` : 'translate(0, -50%)',
          }}
        />
      </button>
      {label && (
        <span className="font-mono tracking-widest uppercase text-[length:var(--font-size-xs)] text-[var(--color-text,#0a0a0a)] select-none">
          {label}
        </span>
      )}
    </label>
  );
};
