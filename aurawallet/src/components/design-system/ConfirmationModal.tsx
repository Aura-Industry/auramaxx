'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'default';
  loading?: boolean;
}

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'CONFIRM',
  cancelText = 'CANCEL',
  variant = 'default',
  loading = false,
}) => {
  const variantStyles = {
    danger: {
      icon: 'text-[var(--color-warning,#ff4d00)]',
      iconBg: 'bg-[var(--color-warning,#ff4d00)]/10',
      border: 'border-[var(--color-warning,#ff4d00)]',
      buttonVariant: 'danger' as const,
      buttonClassName: '',
    },
    warning: {
      icon: 'text-[var(--color-warning-alt,#ff9500)]',
      iconBg: 'bg-[var(--color-warning-alt,#ff9500)]/10',
      border: 'border-[var(--color-warning-alt,#ff9500)]',
      buttonVariant: 'secondary' as const,
      buttonClassName: '!bg-[var(--color-warning-alt,#ff9500)] !text-white !border-[var(--color-warning-alt,#ff9500)] hover:!bg-[var(--color-warning-alt,#ff9500)]/90',
    },
    default: {
      icon: 'text-[var(--color-text,#0a0a0a)]',
      iconBg: 'bg-[var(--color-text,#0a0a0a)]/10',
      border: 'border-[var(--color-text,#0a0a0a)]',
      buttonVariant: 'primary' as const,
      buttonClassName: '',
    },
  };

  const styles = variantStyles[variant];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      icon={
        <AlertTriangle style={{ width: 'var(--font-size-lg)', height: 'var(--font-size-lg)' }} className={styles.icon} />
      }
      size="sm"
    >
      <div className="space-y-[var(--space-4)]">
        <p className="font-mono text-[length:var(--font-size-sm)] text-[var(--color-text-muted,#6b7280)] leading-relaxed">
          {message}
        </p>

        {variant === 'danger' && (
          <div className={`p-[var(--space-3)] ${styles.iconBg} border ${styles.border} border-dashed`}>
            <div className="flex items-center gap-[var(--space-2)]">
              <AlertTriangle style={{ width: 'var(--font-size-sm)', height: 'var(--font-size-sm)' }} className={styles.icon} />
              <span className="font-mono text-[length:var(--font-size-sm)] text-[var(--color-text-muted,#6b7280)]">
                This action cannot be undone.
              </span>
            </div>
          </div>
        )}

        <div className="flex gap-[var(--space-2)] pt-[var(--space-2)]">
          <Button
            onClick={onClose}
            disabled={loading}
            variant="secondary"
            size="lg"
            className="flex-1"
          >
            {cancelText}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={loading}
            variant={styles.buttonVariant}
            size="lg"
            loading={loading}
            className={`flex-1 ${styles.buttonClassName}`}
          >
            {loading ? 'PROCESSING...' : confirmText}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
