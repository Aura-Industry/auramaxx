'use client';

import React from 'react';
import { Minus, X, MoreHorizontal, LucideIcon } from 'lucide-react';

interface AppAction {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
}

interface AppProps {
  title: string;
  icon?: LucideIcon;
  size?: 'compact' | 'small' | 'medium' | 'large' | 'wide' | 'full';
  dismissable?: boolean;
  collapsible?: boolean;
  onDismiss?: () => void;
  actions?: AppAction[];
  children: React.ReactNode;
  className?: string;
  status?: 'normal' | 'alert' | 'success';
}

const sizeClasses = {
  compact: 'col-span-3',
  small: 'col-span-4',
  medium: 'col-span-6',
  large: 'col-span-8',
  wide: 'col-span-9',
  full: 'col-span-12',
};

export const App: React.FC<AppProps> = ({
  title,
  icon: Icon,
  size = 'small',
  dismissable = false,
  collapsible = false,
  onDismiss,
  actions,
  children,
  className = '',
  status = 'normal',
}) => {
  const [collapsed, setCollapsed] = React.useState(false);

  const statusBorders: Record<string, string> = {
    normal: 'var(--color-border, #e5e5e5)',
    alert: 'var(--color-warning, #ff4d00)',
    success: 'var(--color-accent, #ccff00)',
  };

  return (
    <div className={`${sizeClasses[size]} ${className}`}>
      <div
        className="relative overflow-hidden group"
        style={{
          background: 'var(--color-surface, #ffffff)',
          border: `1px solid ${statusBorders[status]}`,
        }}
      >
        {/* Corner Brackets */}
        <div className="absolute top-1 left-1 w-2 h-2 opacity-50" style={{ borderLeft: '1px solid var(--color-border, #e5e5e5)', borderTop: '1px solid var(--color-border, #e5e5e5)' }} />
        <div className="absolute top-1 right-1 w-2 h-2 opacity-50" style={{ borderRight: '1px solid var(--color-border, #e5e5e5)', borderTop: '1px solid var(--color-border, #e5e5e5)' }} />
        <div className="absolute bottom-1 left-1 w-2 h-2 opacity-50" style={{ borderLeft: '1px solid var(--color-border, #e5e5e5)', borderBottom: '1px solid var(--color-border, #e5e5e5)' }} />
        <div className="absolute bottom-1 right-1 w-2 h-2 opacity-50" style={{ borderRight: '1px solid var(--color-border, #e5e5e5)', borderBottom: '1px solid var(--color-border, #e5e5e5)' }} />

        {/* Noise Texture */}
        <div className="absolute inset-0 opacity-[0.02] pointer-events-none bg-[radial-gradient(var(--color-text,#000)_1px,transparent_1px)] bg-[size:3px_3px]" />

        {/* Header */}
        <div
          className="px-3 py-2 flex items-center justify-between relative z-10"
          style={{ borderBottom: '1px solid var(--color-border-muted, #eee)' }}
        >
          <div className="flex items-center gap-2">
            {Icon && <Icon size={12} style={{ color: 'var(--color-text-muted, #888)' }} />}
            <span className="font-mono text-[10px] font-bold tracking-widest uppercase" style={{ color: 'var(--color-text, #0a0a0a)' }}>{title}</span>
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {collapsible && (
              <button
                onClick={() => setCollapsed(!collapsed)}
                className="p-1 transition-colors"
              >
                <Minus size={10} style={{ color: 'var(--color-text-muted, #888)' }} />
              </button>
            )}
            {dismissable && (
              <button
                onClick={onDismiss}
                className="p-1 transition-colors"
              >
                <X size={10} style={{ color: 'var(--color-text-muted, #888)' }} />
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        {!collapsed && (
          <div className="p-3 relative z-10">
            {children}
          </div>
        )}

        {/* Footer Actions */}
        {!collapsed && actions && actions.length > 0 && (
          <div
            className="px-3 py-2 flex items-center gap-2 relative z-10"
            style={{ borderTop: '1px solid var(--color-border-muted, #eee)' }}
          >
            {actions.slice(0, 2).map((action, i) => {
              const ActionIcon = action.icon;
              const variantStyles: Record<string, React.CSSProperties> = {
                primary: {
                  background: 'var(--color-text, #0a0a0a)',
                  color: 'var(--color-surface, #ffffff)',
                },
                secondary: {
                  border: '1px solid var(--color-border, #e5e5e5)',
                  color: 'var(--color-text-muted, #888)',
                },
                danger: {
                  border: '1px solid var(--color-warning, #ff4d00)',
                  color: 'var(--color-warning, #ff4d00)',
                },
              };
              return (
                <button
                  key={i}
                  onClick={action.onClick}
                  className="px-3 py-1.5 font-mono text-[9px] tracking-widest flex items-center gap-1.5 transition-colors"
                  style={variantStyles[action.variant || 'secondary']}
                >
                  {ActionIcon && <ActionIcon size={10} />}
                  {action.label}
                </button>
              );
            })}
            {actions.length > 2 && (
              <button className="ml-auto p-1 transition-colors">
                <MoreHorizontal size={12} style={{ color: 'var(--color-text-muted, #888)' }} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
