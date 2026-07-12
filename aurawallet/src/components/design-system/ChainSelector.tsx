'use client';

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { getChainIcon } from '@/components/icons/ChainIcons';

const CHAIN_COLORS: Record<string, string> = {
  base: '#0052FF',
  ethereum: '#627EEA',
  arbitrum: '#28A0F0',
  optimism: '#FF0420',
  polygon: '#8247E5',
};

interface ChainSelectorProps {
  value: string;
  onChange: (chain: string) => void;
  chains: string[];
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  label?: string;
}

export const ChainSelector: React.FC<ChainSelectorProps> = ({
  value,
  onChange,
  chains,
  disabled = false,
  size = 'sm',
  className = '',
  label,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  const ChainIcon = getChainIcon(value);
  const chainColor = CHAIN_COLORS[value.toLowerCase()] || '#888';
  const compact = size === 'sm';

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const scale = Number.parseFloat(
        window.getComputedStyle(document.documentElement).getPropertyValue('--ui-scale-factor'),
      ) || 1;
      setPosition({
        top: rect.bottom + Math.round(4 * scale),
        left: rect.left,
        width: Math.max(rect.width, 100),
      });
    }
  }, [isOpen]);

  return (
    <div className={`relative w-full ${className}`}>
      {label && (
        <label className="block text-[length:var(--font-size-xs)] font-mono font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] mb-[var(--space-1)] px-[var(--space-1)] pointer-events-none">
          {label}
        </label>
      )}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          w-full ${compact ? 'h-[var(--control-height-sm)] text-[length:var(--font-size-xs)]' : 'h-[calc(var(--control-height-lg)+var(--space-2))] text-[length:var(--font-size-md)]'} flex items-center justify-between px-[var(--space-2)] outline-none group
          bg-[var(--color-background-alt,#f4f4f5)] border font-mono font-bold tracking-wider text-[var(--color-text,#0a0a0a)]
          transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed
          ${isOpen
            ? 'border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-surface,#ffffff)] shadow-mech'
            : 'border-[var(--color-border,#d4d4d8)] hover:border-[var(--color-border-muted,#a1a1aa)] hover:bg-[var(--color-surface,#ffffff)]'
          }
        `}
      >
        <span className="flex items-center gap-[var(--space-1)] truncate">
          <span style={{ color: chainColor }}>
            <ChainIcon size={compact ? 10 : 12} />
          </span>
          <span className="uppercase">{value}</span>
        </span>
        <ChevronDown
          className={`transform transition-transform text-[var(--color-text-muted,#6b7280)] group-hover:text-[var(--color-text,#0a0a0a)] ${isOpen ? 'rotate-180 text-[var(--color-text,#0a0a0a)]' : ''}`}
          style={{
            width: compact ? 'var(--font-size-sm)' : 'var(--font-size-md)',
            height: compact ? 'var(--font-size-sm)' : 'var(--font-size-md)',
          }}
        />
      </button>

      {isOpen && (
        <>
          <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-border-focus,#0a0a0a)] pointer-events-none z-30" />
          <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-border-focus,#0a0a0a)] pointer-events-none z-30" />
        </>
      )}

      {isOpen && mounted && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setIsOpen(false)} />
          <div
            className="fixed z-[9999] bg-[var(--color-surface,#ffffff)] border border-[var(--color-border-focus,#0a0a0a)] shadow-mech overflow-y-auto"
            style={{
              top: position?.top,
              left: position?.left,
              width: position?.width,
              maxHeight: 'calc(12rem * var(--ui-scale-factor, 1))',
            }}
          >
            {chains.map((chain) => {
              const OptionChainIcon = getChainIcon(chain);
              const optionColor = CHAIN_COLORS[chain.toLowerCase()] || '#888';
              return (
                <button
                  key={chain}
                  type="button"
                  onClick={() => {
                    onChange(chain);
                    setIsOpen(false);
                  }}
                  className={`w-full text-left px-[var(--space-2)] py-[var(--space-2)] text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] font-mono ${compact ? 'text-[length:var(--font-size-xs)]' : 'text-[length:var(--font-size-sm)]'} border-b border-[var(--color-border-muted,#e5e5e5)] last:border-0 flex items-center gap-[var(--space-2)] group/item uppercase tracking-wider`}
                >
                  <span style={{ color: optionColor }}>
                    <OptionChainIcon size={compact ? 10 : 12} />
                  </span>
                  <span className="truncate">{chain}</span>
                  <div className={`ml-auto w-1.5 h-1.5 flex-shrink-0 ${chain === value ? 'bg-[var(--color-text,#0a0a0a)]' : 'bg-[var(--color-border,#d4d4d8)] group-hover/item:bg-[var(--color-text,#0a0a0a)]'}`} />
                </button>
              );
            })}
          </div>
        </>,
        document.body
      )}
    </div>
  );
};

export default ChainSelector;
