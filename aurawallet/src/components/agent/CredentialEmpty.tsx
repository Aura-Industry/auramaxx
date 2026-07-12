'use client';

import React from 'react';
import { ShieldCheck, Plus } from 'lucide-react';
import { Button } from '@/components/design-system';

interface CredentialEmptyProps {
  variant: 'no-selection' | 'empty-agent' | 'empty-lifecycle';
  onAdd?: () => void;
}

export const CredentialEmpty: React.FC<CredentialEmptyProps> = ({ variant, onAdd }) => {
  if (variant === 'no-selection') {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-center">
          <ShieldCheck size={32} className="mx-auto mb-3 text-[var(--color-text-faint,#9ca3af)]" />
          <div className="font-mono text-[11px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
            Select a credential from the list
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'empty-lifecycle') {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-center">
          <ShieldCheck size={32} className="mx-auto mb-3 text-[var(--color-text-faint,#9ca3af)]" />
          <div className="font-mono text-[11px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] mb-1">
            No credentials in this section
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center h-full">
      <div className="text-center">
        <ShieldCheck size={32} className="mx-auto mb-3 text-[var(--color-text-faint,#9ca3af)]" />
        <div className="font-mono text-[11px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] mb-1">
          Your agent is empty
        </div>
        <div className="font-mono text-[9px] text-[var(--color-text-faint,#9ca3af)] mb-4">
          Create your first credential
        </div>
        <Button size="sm" onClick={onAdd} icon={<Plus size={10} />}>
          ADD
        </Button>
      </div>
    </div>
  );
};
