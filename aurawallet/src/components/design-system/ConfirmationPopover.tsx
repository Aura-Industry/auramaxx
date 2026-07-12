'use client';

import React from 'react';
import { Popover } from './Popover';
import { Button } from './Button';

interface ConfirmationPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  confirmDisabledReason?: string;
  loading?: boolean;
  anchorEl?: HTMLElement | null;
  anchor?: 'left' | 'right';
}

export const ConfirmationPopover: React.FC<ConfirmationPopoverProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'CONFIRM',
  cancelLabel = 'CANCEL',
  confirmDisabled = false,
  confirmDisabledReason,
  loading = false,
  anchorEl,
  anchor = 'right',
}) => {
  return (
    <Popover
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      anchorEl={anchorEl}
      anchor={anchor}
      className="min-w-[240px] max-w-[300px]"
    >
      <div className="space-y-[var(--space-3)]">
        <p className="font-mono text-[length:var(--font-size-sm)] text-[var(--color-text-muted,#6b7280)] leading-relaxed">
          {message}
        </p>

        {confirmDisabled && confirmDisabledReason && (
          <div className="p-[var(--space-2)] bg-[var(--color-warning,#ff4d00)]/10 border border-[var(--color-warning,#ff4d00)]/30">
            <p className="font-mono text-[length:var(--font-size-xs)] text-[var(--color-warning,#ff4d00)]">
              {confirmDisabledReason}
            </p>
          </div>
        )}

        <div className="flex gap-[var(--space-2)] pt-[var(--space-1)]">
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            className="flex-1"
          >
            {cancelLabel}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={onConfirm}
            disabled={confirmDisabled || loading}
            loading={loading}
            className="flex-1"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Popover>
  );
};
