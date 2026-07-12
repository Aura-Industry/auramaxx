'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, GripVertical, LucideIcon, Lock, Unlock, ExternalLink, RotateCcw } from 'lucide-react';

// App color system - uses CSS variables for theme support
export type AppColor = 'blue' | 'orange' | 'lime' | 'purple' | 'gray' | 'teal' | 'rose';

// CSS variable-based color classes for theme awareness
export const APP_COLORS: Record<AppColor, { band: string; accent: string; bg: string; text: string }> = {
  blue: {
    band: 'bg-[var(--app-blue-band,#0047ff)]',
    accent: 'border-[var(--app-blue-accent,rgba(0,71,255,0.3))]',
    bg: 'bg-[var(--app-blue-bg,rgba(0,71,255,0.05))]',
    text: 'text-[var(--app-blue-text,#0047ff)]',
  },
  orange: {
    band: 'bg-[var(--app-orange-band,#ff4d00)]',
    accent: 'border-[var(--app-orange-accent,rgba(255,77,0,0.3))]',
    bg: 'bg-[var(--app-orange-bg,rgba(255,77,0,0.05))]',
    text: 'text-[var(--app-orange-text,#ff4d00)]',
  },
  lime: {
    band: 'bg-[var(--app-lime-band,#84cc16)]',
    accent: 'border-[var(--app-lime-accent,rgba(132,204,22,0.3))]',
    bg: 'bg-[var(--app-lime-bg,rgba(132,204,22,0.05))]',
    text: 'text-[var(--app-lime-text,#65a30d)]',
  },
  purple: {
    band: 'bg-[var(--app-purple-band,#7c3aed)]',
    accent: 'border-[var(--app-purple-accent,rgba(124,58,237,0.3))]',
    bg: 'bg-[var(--app-purple-bg,rgba(124,58,237,0.05))]',
    text: 'text-[var(--app-purple-text,#7c3aed)]',
  },
  gray: {
    band: 'bg-[var(--app-gray-band,#6b7280)]',
    accent: 'border-[var(--app-gray-accent,rgba(107,114,128,0.3))]',
    bg: 'bg-[var(--app-gray-bg,rgba(107,114,128,0.05))]',
    text: 'text-[var(--app-gray-text,#6b7280)]',
  },
  teal: {
    band: 'bg-[var(--app-teal-band,#14b8a6)]',
    accent: 'border-[var(--app-teal-accent,rgba(20,184,166,0.3))]',
    bg: 'bg-[var(--app-teal-bg,rgba(20,184,166,0.05))]',
    text: 'text-[var(--app-teal-text,#14b8a6)]',
  },
  rose: {
    band: 'bg-[var(--app-rose-band,#f43f5e)]',
    accent: 'border-[var(--app-rose-accent,rgba(244,63,94,0.3))]',
    bg: 'bg-[var(--app-rose-bg,rgba(244,63,94,0.05))]',
    text: 'text-[var(--app-rose-text,#f43f5e)]',
  },
};

type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | null;

interface DraggableAppProps {
  id: string;
  title: string;
  subtitle?: string;
  subtitleLink?: string;
  icon?: LucideIcon;
  color?: AppColor | string;
  initialPosition?: { x: number; y: number };
  initialSize?: { width: number; height: number };
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  resizable?: boolean;
  dismissable?: boolean;
  locked?: boolean;
  onLockChange?: (id: string, locked: boolean) => void;
  onRefresh?: () => void;
  onDismiss?: () => void;
  onPositionChange?: (id: string, pos: { x: number; y: number }) => void;
  onSizeChange?: (id: string, size: { width: number; height: number }) => void;
  onBringToFront?: (id: string) => void;
  children: React.ReactNode;
  className?: string;
  status?: 'normal' | 'alert' | 'success';
  zIndex?: number;
  focusTrigger?: number;
}

export const DraggableApp: React.FC<DraggableAppProps> = ({
  id,
  title,
  subtitle,
  subtitleLink,
  icon: Icon,
  color,
  initialPosition = { x: 20, y: 20 },
  initialSize = { width: 320, height: 'auto' as unknown as number },
  minWidth = 200,
  minHeight = 100,
  maxWidth = 2000,
  maxHeight = 2000,
  resizable = true,
  dismissable = false,
  locked = false,
  onLockChange,
  onRefresh,
  onDismiss,
  onPositionChange,
  onSizeChange,
  onBringToFront,
  children,
  className = '',
  status = 'normal',
  zIndex = 10,
  focusTrigger,
}) => {
  const isPresetColor = color && color in APP_COLORS;
  const colorScheme = isPresetColor ? APP_COLORS[color as AppColor] : null;
  const customColor = !isPresetColor && color?.startsWith('#') ? color : null;

  // Committed state (what's saved)
  const [position, setPosition] = useState(initialPosition);
  const [size, setSize] = useState({
    width: typeof initialSize.width === 'number' ? initialSize.width : 320,
    height: typeof initialSize.height === 'number' ? initialSize.height : 200,
  });

  // Interaction state
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isLocked, setIsLocked] = useState(locked);
  const [, setIsFocusing] = useState(false);

  // Refs for smooth dragging/resizing (avoid re-renders during movement)
  const appRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ startX: 0, startY: 0, startPosX: 0, startPosY: 0 });
  const resizeRef = useRef({
    direction: null as ResizeDirection,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
    startPosX: 0,
    startPosY: 0,
  });
  const prevZIndexRef = useRef(zIndex);

  // Sync with external props
  useEffect(() => {
    setIsLocked(locked);
  }, [locked]);

  // Sync position when initialPosition changes (e.g., from tidy operation)
  useEffect(() => {
    setPosition(initialPosition);
  }, [initialPosition.x, initialPosition.y]);

  useEffect(() => {
    if (typeof initialSize.width === 'number') {
      setSize(prev => ({ ...prev, width: initialSize.width }));
    }
    if (typeof initialSize.height === 'number') {
      setSize(prev => ({ ...prev, height: initialSize.height as number }));
    }
  }, [initialSize.width, initialSize.height]);

  // Focus animation on zIndex change
  useEffect(() => {
    const prevZ = prevZIndexRef.current;
    prevZIndexRef.current = zIndex;
    if (zIndex > prevZ) {
      setIsFocusing(true);
      const timer = setTimeout(() => setIsFocusing(false), 250);
      return () => clearTimeout(timer);
    }
  }, [zIndex]);

  useEffect(() => {
    if (focusTrigger !== undefined && focusTrigger > 0) {
      setIsFocusing(true);
      const timer = setTimeout(() => setIsFocusing(false), 250);
      return () => clearTimeout(timer);
    }
  }, [focusTrigger]);

  // Bring to front when an iframe inside this app receives focus (click).
  // Iframes swallow mouse events so the outer onClick never fires — detect
  // the focus shift via the window blur event instead.
  useEffect(() => {
    const handleWindowBlur = () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (active?.tagName === 'IFRAME' && appRef.current?.contains(active)) {
          onBringToFront?.(id);
        }
      }, 0);
    };

    window.addEventListener('blur', handleWindowBlur);
    return () => window.removeEventListener('blur', handleWindowBlur);
  }, [id, onBringToFront]);

  const statusColors = {
    normal: 'border-[var(--color-border-muted,#e5e5e5)]',
    alert: 'border-[var(--color-warning,#ff4d00)]',
    success: 'border-[var(--color-accent,#ccff00)]',
  };

  // Commit changes (called on mouse up, click, or escape)
  const commitChanges = useCallback(() => {
    if (!appRef.current) return;

    const rect = appRef.current.getBoundingClientRect();
    const parent = appRef.current.offsetParent as HTMLElement;
    const parentRect = parent?.getBoundingClientRect() || { left: 0, top: 0 };

    const newX = rect.left - parentRect.left;
    const newY = rect.top - parentRect.top;
    const newWidth = rect.width;
    const newHeight = rect.height;

    setPosition({ x: newX, y: newY });
    setSize({ width: newWidth, height: newHeight });

    if (isDragging || isResizing) {
      onPositionChange?.(id, { x: newX, y: newY });
    }
    if (isResizing) {
      onSizeChange?.(id, { width: newWidth, height: newHeight });
    }

    setIsDragging(false);
    setIsResizing(false);
  }, [id, isDragging, isResizing, onPositionChange, onSizeChange]);

  // Drag start
  const handleDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('input')) {
      return;
    }
    onBringToFront?.(id);
    if (isLocked) return;

    e.preventDefault();
    setIsDragging(true);

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPosX: position.x,
      startPosY: position.y,
    };
  };

  // Resize start
  const handleResizeStart = useCallback((e: React.MouseEvent, direction: ResizeDirection) => {
    if (isLocked || !resizable) return;
    e.preventDefault();
    e.stopPropagation();
    onBringToFront?.(id);
    setIsResizing(true);

    resizeRef.current = {
      direction,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: size.width,
      startHeight: size.height,
      startPosX: position.x,
      startPosY: position.y,
    };
  }, [isLocked, resizable, size, position, id, onBringToFront]);

  const handleLockToggle = () => {
    const newLocked = !isLocked;
    setIsLocked(newLocked);
    onLockChange?.(id, newLocked);
  };

  // Click anywhere to bring to front
  const handleAppClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button') ||
        (e.target as HTMLElement).closest('input') ||
        (e.target as HTMLElement).closest('a') ||
        (e.target as HTMLElement).closest('textarea') ||
        (e.target as HTMLElement).closest('select')) {
      return;
    }

    // If we're dragging or resizing, commit on click
    if (isDragging || isResizing) {
      commitChanges();
      return;
    }

    onBringToFront?.(id);
  };

  // Mouse move/up effects - use direct DOM manipulation for smoothness
  useEffect(() => {
    if (!isDragging && !isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!appRef.current) return;

      if (isDragging) {
        const deltaX = e.clientX - dragRef.current.startX;
        const deltaY = e.clientY - dragRef.current.startY;
        const newX = Math.max(0, dragRef.current.startPosX + deltaX);
        const newY = Math.max(0, dragRef.current.startPosY + deltaY);

        appRef.current.style.left = `${newX}px`;
        appRef.current.style.top = `${newY}px`;
      } else if (isResizing && resizeRef.current.direction) {
        const deltaX = e.clientX - resizeRef.current.startX;
        const deltaY = e.clientY - resizeRef.current.startY;
        const dir = resizeRef.current.direction;

        let newWidth = resizeRef.current.startWidth;
        let newHeight = resizeRef.current.startHeight;
        let newX = resizeRef.current.startPosX;
        let newY = resizeRef.current.startPosY;

        // Horizontal
        if (dir.includes('e')) {
          newWidth = Math.min(maxWidth, Math.max(minWidth, resizeRef.current.startWidth + deltaX));
        }
        if (dir.includes('w')) {
          const potentialWidth = resizeRef.current.startWidth - deltaX;
          if (potentialWidth >= minWidth && potentialWidth <= maxWidth) {
            newWidth = potentialWidth;
            newX = resizeRef.current.startPosX + deltaX;
          }
        }

        // Vertical
        if (dir.includes('s')) {
          newHeight = Math.min(maxHeight, Math.max(minHeight, resizeRef.current.startHeight + deltaY));
        }
        if (dir.includes('n')) {
          const potentialHeight = resizeRef.current.startHeight - deltaY;
          if (potentialHeight >= minHeight && potentialHeight <= maxHeight) {
            newHeight = potentialHeight;
            newY = resizeRef.current.startPosY + deltaY;
          }
        }

        appRef.current.style.width = `${newWidth}px`;
        appRef.current.style.height = `${newHeight}px`;
        appRef.current.style.left = `${Math.max(0, newX)}px`;
        appRef.current.style.top = `${Math.max(0, newY)}px`;
      }
    };

    const handleMouseUp = () => {
      commitChanges();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        commitChanges();
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isDragging, isResizing, commitChanges, minWidth, minHeight, maxWidth, maxHeight]);

  const resizeHandleClass = "absolute z-20";

  return (
    <div
      ref={appRef}
      className={`absolute ${className}`}
      onClick={handleAppClick}
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        minWidth,
        minHeight,
        zIndex: isDragging || isResizing ? 1000 : zIndex,
        transform: 'scale(1)',
        transition: 'none',
        transformOrigin: 'top left',
        willChange: isDragging || isResizing ? 'left, top, width, height' : 'auto',
      }}
    >
      <div
        className={`bg-[var(--color-surface,#ffffff)] border ${colorScheme ? colorScheme.accent : (!customColor ? statusColors[status] : '')} relative overflow-hidden h-full flex flex-col`}
        style={{
          borderColor: customColor ? `${customColor}4D` : undefined,
          boxShadow: isDragging || isResizing
            ? '6px 6px 0 rgba(0,0,0,0.1)'
            : '4px 4px 0 rgba(0,0,0,0.05)',
        }}
      >
        {/* Color Band */}
        {(colorScheme || customColor) && (
          <div
            className={`absolute top-0 left-0 right-0 h-1 ${colorScheme ? colorScheme.band : ''}`}
            style={customColor ? { backgroundColor: customColor } : undefined}
          />
        )}

        {/* Corner Brackets */}
        <div className="absolute top-1 left-1 w-2 h-2 border-l border-t border-[var(--color-border,#d4d4d8)] opacity-50 pointer-events-none" />
        <div className="absolute top-1 right-1 w-2 h-2 border-r border-t border-[var(--color-border,#d4d4d8)] opacity-50 pointer-events-none" />
        <div className="absolute bottom-1 left-1 w-2 h-2 border-l border-b border-[var(--color-border,#d4d4d8)] opacity-50 pointer-events-none" />
        <div className="absolute bottom-1 right-1 w-2 h-2 border-r border-b border-[var(--color-border,#d4d4d8)] opacity-50 pointer-events-none" />

        {/* Noise Texture */}
        <div className="absolute inset-0 opacity-[0.02] pointer-events-none bg-[radial-gradient(#000_1px,transparent_1px)] bg-[size:3px_3px]" />

        {/* Resize Handles */}
        {resizable && !isLocked && (
          <>
            {/* Edge handles */}
            <div
              className={`${resizeHandleClass} top-0 left-3 right-3 h-2 cursor-n-resize`}
              onMouseDown={(e) => handleResizeStart(e, 'n')}
            />
            <div
              className={`${resizeHandleClass} bottom-0 left-3 right-3 h-2 cursor-s-resize`}
              onMouseDown={(e) => handleResizeStart(e, 's')}
            />
            <div
              className={`${resizeHandleClass} left-0 top-3 bottom-3 w-2 cursor-w-resize`}
              onMouseDown={(e) => handleResizeStart(e, 'w')}
            />
            <div
              className={`${resizeHandleClass} right-0 top-3 bottom-3 w-2 cursor-e-resize`}
              onMouseDown={(e) => handleResizeStart(e, 'e')}
            />

            {/* Corner handles */}
            <div
              className={`${resizeHandleClass} top-0 left-0 w-3 h-3 cursor-nw-resize`}
              onMouseDown={(e) => handleResizeStart(e, 'nw')}
            />
            <div
              className={`${resizeHandleClass} top-0 right-0 w-3 h-3 cursor-ne-resize`}
              onMouseDown={(e) => handleResizeStart(e, 'ne')}
            />
            <div
              className={`${resizeHandleClass} bottom-0 left-0 w-3 h-3 cursor-sw-resize`}
              onMouseDown={(e) => handleResizeStart(e, 'sw')}
            />
            <div
              className={`${resizeHandleClass} bottom-0 right-0 w-5 h-5 cursor-se-resize group/resize`}
              onMouseDown={(e) => handleResizeStart(e, 'se')}
            >
              {/* Visual resize grip */}
              <svg
                className="absolute bottom-1 right-1 w-2.5 h-2.5 text-[var(--color-border,#d4d4d8)] group-hover/resize:text-[var(--color-text-muted,#6b7280)] transition-colors"
                viewBox="0 0 10 10"
                fill="currentColor"
              >
                <circle cx="8.5" cy="1.5" r="1" />
                <circle cx="8.5" cy="5" r="1" />
                <circle cx="8.5" cy="8.5" r="1" />
                <circle cx="5" cy="5" r="1" />
                <circle cx="5" cy="8.5" r="1" />
                <circle cx="1.5" cy="8.5" r="1" />
              </svg>
            </div>
          </>
        )}

        {/* Header - Draggable */}
        <div
          className={`px-3 py-2 border-b border-[var(--color-border-muted,#e5e5e5)] flex items-center justify-between relative z-10 shrink-0 ${(colorScheme || customColor) ? 'pt-3' : ''} ${
            isLocked ? 'cursor-default' : isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          onMouseDown={handleDragStart}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {!isLocked && <GripVertical size={10} className="text-[var(--color-text-faint,#9ca3af)] shrink-0" />}
            {isLocked && <Lock size={10} className="text-[var(--color-text-faint,#9ca3af)] shrink-0" />}
            {Icon && (
              <Icon
                size={12}
                className={`shrink-0 ${colorScheme ? colorScheme.text : 'text-[var(--color-text-muted,#6b7280)]'}`}
                style={customColor ? { color: customColor } : undefined}
              />
            )}
            <span
              className={`font-mono text-[10px] font-bold tracking-widest uppercase select-none shrink-0 ${colorScheme ? colorScheme.text : 'text-[var(--color-text,#0a0a0a)]'}`}
              style={customColor ? { color: customColor } : undefined}
            >
              {title}
            </span>
            {subtitle && (
              <>
                <span className="text-[var(--color-text-faint,#9ca3af)] shrink-0">·</span>
                <span className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] truncate">
                  {subtitle}
                </span>
                {subtitleLink && (
                  <a
                    href={subtitleLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-0.5 hover:bg-[var(--color-surface-alt,#fafafa)] rounded transition-colors shrink-0"
                    title="Open in new tab"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <ExternalLink size={9} className="text-[var(--color-text-muted,#6b7280)]" />
                  </a>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            {onRefresh && (
              <button
                onClick={onRefresh}
                className="p-1 hover:bg-[var(--color-surface-alt,#fafafa)] transition-colors"
                title="Refresh app"
              >
                <RotateCcw size={10} className="text-[var(--color-text-muted,#6b7280)]" />
              </button>
            )}
            <button
              onClick={handleLockToggle}
              className="p-1 hover:bg-[var(--color-surface-alt,#fafafa)] transition-colors"
              title={isLocked ? 'Unlock app' : 'Lock app'}
            >
              {isLocked ? (
                <Lock size={10} className="text-[var(--color-text,#0a0a0a)]" />
              ) : (
                <Unlock size={10} className="text-[var(--color-text-muted,#6b7280)]" />
              )}
            </button>
            {dismissable && (
              <button
                onClick={onDismiss}
                className="p-1 hover:bg-[var(--color-surface-alt,#fafafa)] transition-colors"
              >
                <X size={10} className="text-[var(--color-text-muted,#6b7280)]" />
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div
          className="p-3 relative z-10 flex-1 min-h-0 overflow-auto"
          style={{ pointerEvents: isDragging || isResizing ? 'none' : 'auto' }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};
