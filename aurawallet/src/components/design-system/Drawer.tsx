'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'full';
  footerLabel?: string;
}

export const Drawer: React.FC<DrawerProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  width = 'md',
  footerLabel = '',
}) => {
  const [shouldRender, setShouldRender] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      // Small delay to ensure DOM is ready before animation
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsAnimating(true);
        });
      });
    } else {
      setIsAnimating(false);
      // Wait for exit animation to complete
      const timer = setTimeout(() => {
        setShouldRender(false);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEscape);
    }
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const widthStyles = {
    sm: 'min(100vw, calc(320px * var(--ui-scale-factor, 1)))',
    md: 'min(100vw, calc(400px * var(--ui-scale-factor, 1)))',
    lg: 'min(100vw, calc(520px * var(--ui-scale-factor, 1)))',
    full: '100vw',
  };

  if (!shouldRender || !isMounted) return null;

  const drawerContent = (
    <div
      className="fixed inset-0 z-[110]"
      onMouseDown={onClose}
      data-testid="drawer-backdrop"
    >
      <div className="absolute inset-0 bg-black/10" />
      <div
        className="absolute right-0 top-0 h-full overflow-hidden"
        style={{ width: widthStyles[width] }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className={`
            h-full bg-[var(--color-surface,#ffffff)] flex flex-col clip-specimen border-mech shadow-mech
            transition-transform duration-200 ease-out
            ${isAnimating ? 'translate-x-0' : 'translate-x-full'}
          `}
        >
          {/* Header — hazard accent + specimen label */}
          <div className="relative border-b border-[var(--color-border,#d4d4d8)]">
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-hazard-stripes" />
            <div className="px-[var(--space-4)] pt-[var(--space-3)] pb-[var(--space-2)]">
              <div className="flex items-start justify-between">
                <div>
                  <span className="label-specimen-sm text-[var(--color-text-muted,#6b7280)]">{subtitle || 'PANEL'}</span>
                  <h2 className="font-mono font-bold text-[length:var(--font-size-md)] text-[var(--color-text,#0a0a0a)] tracking-tight mt-[2px]">{title}</h2>
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close drawer"
                  className="p-[var(--space-1)] hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors group -mr-[var(--space-1)]"
                >
                  <X
                    className="text-[var(--color-text-muted,#6b7280)] group-hover:text-[var(--color-text,#0a0a0a)] transition-colors"
                    style={{ width: 'var(--font-size-md)', height: 'var(--font-size-md)' }}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-[var(--space-4)]">
            {children}
          </div>

          {/* Footer — barcode strip */}
          <div className="px-[var(--space-4)] py-[var(--space-2)] border-t border-[var(--color-border,#d4d4d8)]">
            <div className="flex items-center justify-between">
              <span className="label-specimen-sm text-[var(--color-text-faint,#9ca3af)]">{footerLabel || ''}</span>
              <span className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-[0.3em]">|||||||||||</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(drawerContent, document.body);
};
