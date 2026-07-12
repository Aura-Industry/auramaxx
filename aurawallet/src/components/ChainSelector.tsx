'use client';

import React from 'react';
import { ChainSelector as DefaultChainSelector } from '@/components/design-system';

export const SUPPORTED_CHAINS = ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'solana'] as const;

interface ChainSelectorProps {
  value: string;
  onChange: (chain: string) => void;
  includeAll?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  label?: string;
}

export function ChainSelector({
  value,
  onChange,
  includeAll = false,
  disabled = false,
  size = 'sm',
  className = '',
  label,
}: ChainSelectorProps) {
  const chains = includeAll
    ? ['all', ...SUPPORTED_CHAINS]
    : [...SUPPORTED_CHAINS];

  return (
    <DefaultChainSelector
      value={value}
      onChange={onChange}
      chains={chains}
      disabled={disabled}
      size={size}
      className={className}
      label={label}
    />
  );
}

export default ChainSelector;
