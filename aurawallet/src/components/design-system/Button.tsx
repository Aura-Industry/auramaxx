'use client';

import React from 'react';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}

/* Thin barcode strip rendered inside the primary button's right edge */
const BarcodeStrip: React.FC = () => (
  <span
    className="absolute right-0 top-0 bottom-0 w-[6px] pointer-events-none opacity-25"
    aria-hidden="true"
    style={{
      backgroundImage:
        'repeating-linear-gradient(to bottom, var(--color-surface,#ffffff) 0px, var(--color-surface,#ffffff) 2px, transparent 2px, transparent 3px, var(--color-surface,#ffffff) 3px, var(--color-surface,#ffffff) 4px, transparent 4px, transparent 7px)',
    }}
  />
);

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  children,
  disabled,
  className = '',
  ...props
}) => {
  const baseStyles = 'font-mono tracking-widest flex items-center justify-center gap-[var(--space-1)] transition-all disabled:opacity-50 disabled:cursor-not-allowed';

  const isPrimary = variant === 'primary';

  const variantStyles = {
    primary: [
      'relative clip-specimen-sm',
      'bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] border border-[var(--color-text,#0a0a0a)]',
      'shadow-mech hover:shadow-mech-hover active:shadow-mech-active',
      'hover:bg-[var(--color-accent,#ccff00)] hover:text-[var(--color-accent-foreground,#0a0a0a)] hover:border-[var(--color-accent,#ccff00)]',
      'hover:-translate-y-[1px] hover:-translate-x-[1px] active:translate-y-0 active:translate-x-0',
    ].join(' '),
    secondary: 'bg-[var(--color-surface,#ffffff)] border border-[var(--color-border,#d4d4d8)] text-[var(--color-text-muted,#6b7280)] hover:border-[var(--color-text,#0a0a0a)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)]',
    danger: 'bg-[var(--color-surface,#ffffff)] border-2 border-[var(--color-warning,#ff4d00)] text-[var(--color-warning,#ff4d00)] hover:bg-[var(--color-warning,#ff4d00)] hover:text-white',
    ghost: 'bg-transparent text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)]',
  };

  const sizeStyles = {
    sm: 'h-[var(--control-height-sm)] px-[var(--space-2)] text-[length:var(--font-size-xs)]',
    md: 'h-[var(--control-height-md)] px-[var(--space-3)] text-[length:var(--font-size-sm)]',
    lg: 'h-[var(--control-height-lg)] px-[var(--space-4)] text-[length:var(--font-size-md)]',
  };

  const loaderSize = size === 'sm'
    ? 'var(--font-size-xs)'
    : size === 'md'
      ? 'var(--font-size-sm)'
      : 'var(--font-size-md)';

  return (
    <button
      className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          {isPrimary && (
            <span
              className="absolute inset-0 pointer-events-none animate-ticker bg-hazard-stripes opacity-40"
              aria-hidden="true"
            />
          )}
          <Loader2 className="animate-spin relative z-[1]" style={{ width: loaderSize, height: loaderSize }} />
        </>
      ) : icon ? (
        icon
      ) : null}
      <span className="relative z-[1]">{children}</span>
      {isPrimary && !loading && <BarcodeStrip />}
    </button>
  );
};
