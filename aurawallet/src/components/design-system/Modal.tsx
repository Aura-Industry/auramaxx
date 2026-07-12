'use client';

import React, { useEffect, useState, useCallback, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  hideHeader?: boolean;
  hideTitle?: boolean;
  contentClassName?: string;
  headerAction?: React.ReactNode;
  headerActionPosition?: 'left' | 'right';
  footer?: React.ReactNode;
  footerClassName?: string;
  showBottomStripe?: boolean;
  dismissible?: boolean;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  icon,
  size = 'sm',
  hideHeader = false,
  hideTitle: _hideTitle = false,
  contentClassName,
  headerAction,
  headerActionPosition = 'right',
  footer,
  footerClassName,
  showBottomStripe = true,
  dismissible = true,
}) => {
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setVisible(true);
      setClosing(false);
    } else if (visible) {
      setClosing(true);
    }
  }, [isOpen, visible]);

  const handleAnimationEnd = useCallback(() => {
    if (closing) {
      setVisible(false);
      setClosing(false);
    }
  }, [closing]);

  // Lock body scroll when open
  useEffect(() => {
    if (visible && !closing) {
      document.body.style.overflow = 'hidden';
    } else if (!visible) {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [visible, closing]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (!dismissible) return;
      if (e.key === 'Escape') onClose();
    };
    if (visible && !closing) {
      window.addEventListener('keydown', handleEscape);
    }
    return () => window.removeEventListener('keydown', handleEscape);
  }, [visible, closing, dismissible, onClose]);

  // Focus management + keyboard trap
  useEffect(() => {
    if (!visible || closing) return;

    const dialogEl = dialogRef.current;
    if (!dialogEl) return;

    const previousActive = document.activeElement as HTMLElement | null;
    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const isFocusableElement = (el: HTMLElement) => {
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
      if (el.tabIndex === -1) return false;
      if (el.closest('[inert]')) return false;
      if (el.hasAttribute('hidden')) return false;
      if (el instanceof HTMLInputElement && el.type === 'hidden') return false;

      const computedStyle = window.getComputedStyle(el);
      if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') return false;

      return true;
    };

    const getFocusable = () => Array.from(dialogEl.querySelectorAll<HTMLElement>(focusableSelector))
      .filter(isFocusableElement);

    const initialFocusable = getFocusable();
    const priorityFocus = initialFocusable.find((el) => {
      // 1. Check for explicit autoFocus first (highest priority)
      if (el.hasAttribute('autofocus')) return true;
      // 2. Check for form inputs if no autoFocus found
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    });
    (priorityFocus ?? initialFocusable[0] ?? dialogEl).focus();

    const handleTabTrap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        dialogEl.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!active || active === first || !dialogEl.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (!active || active === last || !dialogEl.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    dialogEl.addEventListener('keydown', handleTabTrap);

    return () => {
      dialogEl.removeEventListener('keydown', handleTabTrap);
      previousActive?.focus();
    };
  }, [visible, closing]);

  const sizeStyles = {
    sm: 'min(100%, calc(24rem * var(--ui-scale-factor, 1)))',
    md: 'min(100%, calc(28rem * var(--ui-scale-factor, 1)))',
    lg: 'min(100%, calc(32rem * var(--ui-scale-factor, 1)))',
  };
  const headerTitle = title || subtitle || 'System_Message';

  if (!visible || !mounted) return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[120] overflow-y-auto overflow-x-hidden">
        <div
          className={`absolute inset-0 bg-[var(--color-background-alt,#f4f4f5)]/95 ${closing ? 'animate-fade-out' : 'animate-fade-in'}`}
          onClick={dismissible ? onClose : undefined}
          onAnimationEnd={handleAnimationEnd}
        >
          <div className="absolute inset-0 opacity-[0.1] bg-[radial-gradient(var(--color-text,#000)_1px,transparent_1px)] bg-[size:3px_3px]" />
        </div>

        <div
          data-testid="modal-dismiss-layer"
          className="relative z-10 min-h-full flex items-start sm:items-center justify-center p-[var(--space-3)] sm:p-[var(--space-4)]"
          onClick={dismissible ? onClose : undefined}
        >
          {/* Modal */}
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={!hideHeader && headerTitle ? titleId : undefined}
            tabIndex={-1}
            className={`w-full max-h-[calc(100vh-2rem)] max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100vh-4rem)] sm:max-h-[calc(100dvh-4rem)] flex flex-col overflow-hidden clip-specimen border-mech bg-[var(--color-surface,#ffffff)] shadow-mech font-mono text-[var(--color-text,#0a0a0a)] corner-marks ${closing ? 'animate-terminal-close' : 'animate-terminal'}`}
            style={{ maxWidth: sizeStyles[size] }}
            onClick={(event) => event.stopPropagation()}
          >
            {/* Extra corner marks: top-right + bottom-left */}
            <div className="absolute top-[-1px] right-[-1px] w-2 h-2 border-t-2 border-r-2 border-[var(--color-border-focus,#0a0a0a)] pointer-events-none z-20" />
            <div className="absolute bottom-[-1px] left-[-1px] w-2 h-2 border-b-2 border-l-2 border-[var(--color-border-focus,#0a0a0a)] pointer-events-none z-20" />

            {!hideHeader && (
              <div className="shrink-0 border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] px-[var(--space-4)] py-[var(--space-3)] flex items-center justify-between gap-[var(--space-3)]">
                <div className="flex items-center gap-[var(--space-2)]">
                  {headerActionPosition === 'left' ? headerAction : null}
                  {icon && (
                    <div className="w-6 h-6 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)] flex items-center justify-center shrink-0">
                      {icon}
                    </div>
                  )}
                  <h3
                    id={titleId}
                    className="font-mono text-[length:var(--font-size-xs)] font-bold text-[var(--color-text-muted,#6b7280)] uppercase tracking-[0.25em]"
                  >
                    {headerTitle}
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  {headerActionPosition !== 'left' ? headerAction : null}
                  {dismissible && (
                    <button
                      onClick={onClose}
                      className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
                    >
                      <X style={{ width: 'var(--font-size-md)', height: 'var(--font-size-md)' }} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Content */}
            <div className={`p-[var(--space-6)] flex-1 relative overflow-y-auto overflow-x-hidden min-h-0 ${contentClassName ?? ''}`}>
              {/* Children */}
              <div className="relative z-10 font-mono text-sm tracking-[0.05em] text-[var(--color-text,#0a0a0a)]">
                {children}
              </div>
            </div>

            {footer && (
              <div className={`shrink-0 border-t border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] px-[var(--space-4)] py-2 flex items-center gap-3 ${footerClassName ?? ''}`}>
                {showBottomStripe && (
                  <div className="h-4 flex-1 bg-[repeating-linear-gradient(90deg,var(--color-text,#000),var(--color-text,#000)_1px,transparent_1px,transparent_3px)] opacity-30" />
                )}
                <div className="shrink-0">
                  {footer}
                </div>
              </div>
            )}

          </div>
        </div>
      </div>

      <style>{`
        @keyframes terminal-open {
          0% {
            opacity: 0;
            transform: scaleY(0) scaleX(0.95);
            filter: blur(4px);
          }
          100% {
            opacity: 1;
            transform: scaleY(1) scaleX(1);
            filter: blur(0);
          }
        }
        @keyframes terminal-close {
          0% {
            opacity: 1;
            transform: scaleY(1) scaleX(1);
            filter: blur(0);
          }
          100% {
            opacity: 0;
            transform: scaleY(0) scaleX(0.95);
            filter: blur(4px);
          }
        }
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes fade-out {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        .animate-terminal {
          animation: terminal-open 0.15s cubic-bezier(0.23, 1, 0.32, 1) forwards;
          transform-origin: center;
        }
        .animate-terminal-close {
          animation: terminal-close 0.12s cubic-bezier(0.55, 0, 1, 0.45) forwards;
          transform-origin: center;
        }
        .animate-fade-in {
          animation: fade-in 0.2s ease-out forwards;
        }
        .animate-fade-out {
          animation: fade-out 0.15s ease-in forwards;
        }
      `}</style>
    </>,
    document.body,
  );
};
