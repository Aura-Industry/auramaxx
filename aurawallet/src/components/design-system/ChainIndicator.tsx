'use client';

import React from 'react';
import { getChainIcon } from '@/components/icons/ChainIcons';

// Chain colors for the indicator dot
const CHAIN_COLORS: Record<string, string> = {
  base: '#0052FF',
  ethereum: '#627EEA',
  arbitrum: '#28A0F0',
  optimism: '#FF0420',
  polygon: '#8247E5',
  solana: '#9945FF',
  'solana-devnet': '#9945FF',
};

interface ChainIndicatorProps {
  chain: string;
  size?: 'sm' | 'md';
  className?: string;
}

export const ChainIndicator: React.FC<ChainIndicatorProps> = ({
  chain,
  size = 'sm',
  className = '',
}) => {
  const ChainIcon = getChainIcon(chain);
  const chainColor = CHAIN_COLORS[chain.toLowerCase()] || '#888';

  const sizeStyles = {
    sm: {
      height: 'h-[var(--control-height-sm)]',
      padding: 'px-[var(--space-2)]',
      iconSize: 14,
      text: 'text-[length:var(--font-size-xs)]',
    },
    md: {
      height: 'h-[var(--control-height-md)]',
      padding: 'px-[var(--space-3)]',
      iconSize: 16,
      text: 'text-[length:var(--font-size-sm)]',
    },
  };

  const styles = sizeStyles[size];

  return (
    <div
      className={`${styles.height} ${styles.padding} flex items-center gap-[var(--space-1)] font-mono ${styles.text} tracking-widest uppercase ${className}`}
      style={{
        background: 'var(--color-surface-alt, #f5f5f5)',
        border: '1px solid var(--color-border, #d4d4d8)',
        color: 'var(--color-text, #0a0a0a)',
      }}
    >
      <span style={{ color: chainColor }}>
        <ChainIcon size={styles.iconSize} />
      </span>
      <span>{chain.toUpperCase()}</span>
    </div>
  );
};

export default ChainIndicator;
