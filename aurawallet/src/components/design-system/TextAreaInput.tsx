import React from 'react';

interface TextAreaInputProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: boolean;
  errorMessage?: string;
  hint?: string;
  compact?: boolean;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}

export const TextAreaInput: React.FC<TextAreaInputProps> = ({
  label,
  error,
  errorMessage,
  hint,
  compact = false,
  textareaRef,
  className = '',
  rows = compact ? 4 : 7,
  ...props
}) => {
  const hasLabel = label && label.length > 0;

  return (
    <div className={`flex flex-col gap-[var(--space-1)] w-full group ${className}`}>
      {(hasLabel || error) && (
        <div className="flex justify-between items-end px-[var(--space-1)]">
          {hasLabel && (
            <label className="font-mono text-[length:var(--font-size-xs)] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] group-focus-within:text-[var(--color-text,#0a0a0a)] transition-colors">
              {label}
            </label>
          )}
          {error && errorMessage && (
            <span className="font-mono text-[length:var(--font-size-xs)] text-[var(--color-danger,#ef4444)] uppercase">
              {errorMessage}
            </span>
          )}
          {error && !errorMessage && (
            <span className="font-mono text-[length:var(--font-size-xs)] text-[var(--color-warning,#ff4d00)] font-bold">
              ERR_NULL
            </span>
          )}
        </div>
      )}

      <div className="relative flex">
        <textarea
          ref={textareaRef}
          rows={rows}
          className={`
            w-full ${compact ? 'text-[length:var(--font-size-sm)]' : 'text-[length:var(--font-size-md)]'} bg-[var(--color-background-alt,#f4f4f5)] border outline-none font-mono text-[var(--color-text,#0a0a0a)] placeholder-[var(--color-text-muted,#6b7280)] resize-y
            transition-all duration-200
            border-[var(--color-border,#d4d4d8)]
            hover:border-[var(--color-border-muted,#a1a1aa)] hover:bg-[var(--color-surface,#ffffff)]
            focus:border-[var(--color-border-focus,#0a0a0a)] focus:bg-[var(--color-surface,#ffffff)] focus:shadow-[2px_2px_0_rgba(0,0,0,0.08)]
            ${error ? 'border-[var(--color-danger,#ef4444)]/50 focus:border-[var(--color-danger,#ef4444)] bg-[var(--color-danger,#ef4444)]/5' : ''}
            px-[var(--space-3)] py-[var(--space-2)]
          `}
          {...props}
        />

        <div
          className={`absolute top-0 right-0 w-1.5 h-1.5 border-t border-r transition-opacity ${error ? 'border-[var(--color-danger,#ef4444)] opacity-100' : 'border-[var(--color-border-focus,#0a0a0a)] opacity-0 group-focus-within:opacity-100'}`}
        />
        <div
          className={`absolute bottom-0 left-0 w-1.5 h-1.5 border-b border-l transition-opacity ${error ? 'border-[var(--color-danger,#ef4444)] opacity-100' : 'border-[var(--color-border-focus,#0a0a0a)] opacity-0 group-focus-within:opacity-100'}`}
        />
      </div>

      {hint && (
        <span className="font-mono text-[length:var(--font-size-xs)] text-[var(--color-text-muted,#6b7280)] px-[var(--space-1)]">
          {hint}
        </span>
      )}
    </div>
  );
};
