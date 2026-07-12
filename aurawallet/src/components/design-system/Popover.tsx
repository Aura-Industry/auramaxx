'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
  anchor?: 'left' | 'right';
  /** Element to position the popover relative to (enables portal mode) */
  anchorEl?: HTMLElement | null;
}

export const Popover: React.FC<PopoverProps> = ({
  isOpen,
  onClose,
  title,
  children,
  className = '',
  anchor = 'right',
  anchorEl,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  // Ensure we're on the client
  useEffect(() => {
    setMounted(true);
  }, []);

  // Calculate position based on anchor element (auto-flips above if not enough space below)
  useEffect(() => {
    if (isOpen && anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const flipUp = spaceBelow < 250;
      const left = anchor === 'left' ? rect.left : rect.right;

      if (flipUp) {
        setPosition({ bottom: window.innerHeight - rect.top + 4, left });
      } else {
        setPosition({ top: rect.bottom + 4, left });
      }
    }
  }, [isOpen, anchorEl, anchor]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    if (isOpen) {
      // Delay to prevent immediate close
      setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 0);
    }

    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

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

  if (!isOpen) return null;

  // Use portal when anchorEl is provided (for proper z-index stacking)
  const usePortal = !!anchorEl && mounted;

  const popoverContent = (
    <div
      ref={popoverRef}
      className={`
        bg-[var(--color-surface)] border border-[var(--color-border-focus,#0a0a0a)] shadow-mech
        min-w-[200px] animate-popover
        ${usePortal ? 'fixed z-[9999]' : `absolute z-50 ${anchor === 'right' ? 'right-0' : 'left-0'}`}
        ${className}
      `}
      style={usePortal && position ? {
        ...(position.top !== undefined ? { top: position.top } : {}),
        ...(position.bottom !== undefined ? { bottom: position.bottom } : {}),
        left: anchor === 'left' ? position.left : undefined,
        right: anchor === 'right' ? window.innerWidth - position.left : undefined,
      } : undefined}
    >
      {title && (
        <div className="flex items-center justify-between px-[var(--space-3)] py-[var(--space-2)] border-b border-[var(--color-border)]">
          <span className="text-[length:var(--font-size-xs)] font-mono text-[var(--color-text-muted)] uppercase tracking-widest">{title}</span>
          <div className="flex gap-[2px]">
            <div className="w-1 h-1 bg-[var(--color-text-muted)]" />
            <div className="w-1 h-1 bg-[var(--color-border)]" />
          </div>
        </div>
      )}

      <div className="p-[var(--space-3)]">
        {children}
      </div>

      {/* Decorative corners */}
      <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[var(--color-border-focus,#0a0a0a)]" />
      <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[var(--color-border-focus,#0a0a0a)]" />

      <style jsx>{`
        @keyframes popover-open {
          0% {
            opacity: 0;
            transform: translateY(-4px) scale(0.98);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        .animate-popover {
          animation: popover-open 0.12s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>
    </div>
  );

  if (usePortal) {
    return createPortal(popoverContent, document.body);
  }

  return popoverContent;
};
