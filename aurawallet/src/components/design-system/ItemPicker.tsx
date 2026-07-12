'use client';

import React from 'react';
import { Check } from 'lucide-react';

export interface ItemPickerOption {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  quickActionLabel?: string;
  onQuickAction?: () => void;
}

interface ItemPickerProps {
  options: ItemPickerOption[];
  value: string | string[];
  onChange: (value: any) => void;
  multi?: boolean;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

export const ItemPicker: React.FC<ItemPickerProps> = ({
  options,
  value,
  onChange,
  multi = false,
  className = '',
  disabled = false,
  ariaLabel,
}) => {
  const isSelected = (optionValue: string) => {
    if (multi && Array.isArray(value)) {
      return value.includes(optionValue);
    }
    return value === optionValue;
  };

  const handleSelect = (optionValue: string) => {
    if (disabled) return;

    if (multi) {
      const currentValues = Array.isArray(value) ? value : [];
      if (currentValues.includes(optionValue)) {
        onChange(currentValues.filter((v) => v !== optionValue));
      } else {
        onChange([...currentValues, optionValue]);
      }
    } else {
      onChange(optionValue);
    }
  };

  return (
    <div
      className={`relative clip-specimen-sm border-mech bg-[var(--color-surface,#ffffff)] shadow-mech ${disabled ? 'opacity-60' : ''} ${className}`}
      role={multi ? 'group' : 'radiogroup'}
      aria-label={ariaLabel}
      data-testid="item-picker"
    >
      <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-border-focus,#0a0a0a)] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-border-focus,#0a0a0a)] pointer-events-none" />

      <div className="absolute top-[6px] right-[10px] h-[calc(100%-12px)] w-[14px] opacity-35 pointer-events-none"
        aria-hidden="true"
        style={{
          backgroundImage:
            'repeating-linear-gradient(to bottom, var(--color-text-muted,#71717a) 0px, var(--color-text-muted,#71717a) 2px, transparent 2px, transparent 4px)',
        }}
      />

      {options.map((option, index) => {
        const selected = isSelected(option.value);
        const descriptionId = option.description ? `item-picker-description-${option.value}` : undefined;

        return (
          <div
            key={option.value}
            role={multi ? 'checkbox' : 'radio'}
            tabIndex={disabled ? -1 : 0}
            aria-checked={selected}
            aria-describedby={descriptionId}
            data-testid={`item-picker-option-${option.value}`}
            onClick={() => handleSelect(option.value)}
            onKeyDown={(event) => {
              if (disabled) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleSelect(option.value);
              }
            }}
            className={`
              group relative flex w-full items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-2)] pr-[calc(var(--space-4)+12px)] text-left transition-colors
              ${index !== options.length - 1 ? 'border-b border-[var(--color-border,#d4d4d8)]' : ''}
              ${selected
                ? 'bg-[var(--color-background-alt,#f4f4f5)] text-[var(--color-text,#0a0a0a)] dark:text-[var(--color-text-inverse,#ffffff)]'
                : 'bg-[var(--color-surface,#ffffff)] text-[var(--color-text-muted,#6b7280)] hover:bg-[var(--color-background-alt,#f4f4f5)] hover:text-[var(--color-text,#0a0a0a)] dark:text-[var(--color-text-muted-inverse,#a1a1aa)] dark:hover:text-[var(--color-text-inverse,#ffffff)]'
              }
              ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
            `}
          >
            <span
              className={`
                relative mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center border transition-colors
                ${multi ? 'rounded-[1px]' : 'rounded-full'}
                ${selected
                  ? 'border-[var(--color-text,#0a0a0a)] bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] dark:border-[var(--color-text-inverse,#ffffff)] dark:bg-[var(--color-text-inverse,#ffffff)] dark:text-[var(--color-surface-inverse,#000000)]'
                  : 'border-[var(--color-border-muted,#a1a1aa)] bg-transparent'
                }
              `}
            >
              {selected ? <Check size={8} strokeWidth={3.5} /> : null}
            </span>

            <span className="min-w-0 flex-1">
              <span className="block font-mono text-[10px] font-bold uppercase tracking-widest leading-none">
                {option.label}
              </span>
              {option.description ? (
                <span
                  id={descriptionId}
                  className="mt-1 block font-mono text-[10px] leading-tight text-[var(--color-text-muted,#71717a)] dark:text-[var(--color-text-muted-inverse,#a1a1aa)]"
                >
                  {option.description}
                </span>
              ) : null}
            </span>

            {option.onQuickAction ? (
              <button
                type="button"
                data-testid={`item-picker-quick-action-${option.value}`}
                aria-label={option.quickActionLabel || `Quick create ${option.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  option.onQuickAction?.();
                }}
                disabled={disabled}
                className="shrink-0 inline-flex h-5 w-5 items-center justify-center border border-[var(--color-border,#d4d4d8)] font-mono text-[10px] leading-none text-[var(--color-text-muted,#71717a)] opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 group-focus-within:opacity-100 hover:text-[var(--color-text,#0a0a0a)]"
              >
                +
              </button>
            ) : null}

            {option.icon ? (
              <span className={`shrink-0 ${selected ? 'text-[var(--color-text,#0a0a0a)] dark:text-[var(--color-text-inverse,#ffffff)]' : 'text-[var(--color-text-muted,#71717a)] group-hover:text-[var(--color-text,#0a0a0a)] dark:text-[var(--color-text-muted-inverse,#a1a1aa)] dark:group-hover:text-[var(--color-text-inverse,#ffffff)]'}`}>
                {option.icon}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
