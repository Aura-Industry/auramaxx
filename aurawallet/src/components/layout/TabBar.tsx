'use client';

import React, { useState, useRef } from 'react';
import { LucideIcon, Plus, X, Home as HomeIcon, Pencil, Brush, LayoutGrid } from 'lucide-react';
import { Popover, TextInput } from '@/components/design-system';
import { NotificationDrawer } from '@/components/NotificationDrawer';
import type { HumanAction } from '@/hooks/useAgentActions';

export interface WorkspaceTab {
  id: string;
  label: string;
  icon?: LucideIcon;
  emoji?: string;
  color?: string;
  closeable?: boolean;
  isDefault?: boolean;
}

interface WorkspaceEditData {
  name: string;
  emoji: string;
  color: string;
}

interface TabBarProps {
  tabs: WorkspaceTab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onNewTab?: () => void;
  onTabUpdate?: (tabId: string, data: Partial<WorkspaceEditData>) => void;
  onTidy?: () => void;
  onAppStore?: () => void;
  notifications?: HumanAction[];
  onDismissNotification?: (id: string) => void;
}

const PRESET_COLORS = [
  '#0a0a0a', '#0047ff', '#ff4d00', '#00c853', '#9c27b0', '#ff9800', '#00bcd4', '#e91e63',
];

const PRESET_EMOJIS = [
  '🏠', '💼', '📊', '🚀', '⚡', '🔥', '💎', '🎯', '📈', '🛠️', '🔒', '💰',
];

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTab,
  onTabChange,
  onTabClose,
  onNewTab,
  onTabUpdate,
  onTidy,
  onAppStore,
  notifications = [],
  onDismissNotification,
}) => {
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmoji, setEditEmoji] = useState('');
  const [editColor, setEditColor] = useState('');
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const openEdit = (tab: WorkspaceTab) => {
    setEditingTab(tab.id);
    setEditName(tab.label);
    setEditEmoji(tab.emoji || '');
    setEditColor(tab.color || '');
  };

  const closeEdit = () => {
    // Save name on close (emoji/color already saved instantly)
    if (editingTab && onTabUpdate && editName) {
      const tab = tabs.find(t => t.id === editingTab);
      if (tab && editName !== tab.label) {
        onTabUpdate(editingTab, { name: editName });
      }
    }
    setEditingTab(null);
  };

  const updateEmoji = (emoji: string) => {
    setEditEmoji(emoji);
    if (editingTab && onTabUpdate) {
      onTabUpdate(editingTab, { emoji: emoji || undefined });
    }
  };

  const updateColor = (color: string) => {
    setEditColor(color);
    if (editingTab && onTabUpdate) {
      onTabUpdate(editingTab, { color: color || undefined });
    }
  };

  return (
    <div className="h-10 bg-[var(--color-background-alt,#e8e8e6)] border-b border-[var(--color-border,#d4d4d8)] flex items-end px-2 pt-1 relative">
      {/* Hazard stripe accent — bottom edge */}
      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-hazard-stripes pointer-events-none" />
      {/* Tabs */}
      <div className="flex items-end gap-0.5">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const isHovered = hoveredTab === tab.id;
          const isEditing = editingTab === tab.id;
          const TabIcon = tab.icon || HomeIcon;
          const tabColor = tab.color || (isActive ? 'var(--color-text, #0a0a0a)' : undefined);

          return (
            <div
              key={tab.id}
              ref={(el) => { tabRefs.current[tab.id] = el; }}
              className={`
                relative flex items-center gap-2 px-4 py-2 font-mono text-[10px] tracking-wider
                transition-all rounded-t-sm border border-b-0 group
                ${isActive
                  ? 'bg-[var(--color-surface,#ffffff)] text-[var(--color-text,#0a0a0a)] border-[var(--color-border,#d4d4d8)] z-10 -mb-[1px]'
                  : 'bg-[var(--color-surface-alt,#d8d8d6)] text-[var(--color-text-muted,#6b7280)] border-transparent hover:bg-[var(--color-background-alt,#e0e0de)] cursor-pointer'
                }
              `}
              style={tabColor ? { borderTopColor: tabColor, borderTopWidth: isActive ? '2px' : '1px' } : undefined}
              onClick={() => !isActive && onTabChange(tab.id)}
              onMouseEnter={() => setHoveredTab(tab.id)}
              onMouseLeave={() => setHoveredTab(null)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (isActive) openEdit(tab);
              }}
            >
              {/* Emoji or Icon */}
              {tab.emoji ? (
                <span className="text-xs">{tab.emoji}</span>
              ) : (
                <TabIcon size={12} style={tabColor ? { color: tabColor } : undefined} />
              )}
              <span className="select-none">{tab.label}</span>

              {/* Edit button - shows on hover for active tab */}
              {isActive && isHovered && onTabUpdate && !isEditing && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openEdit(tab);
                  }}
                  className="p-0.5 hover:bg-[var(--color-background-alt,#e5e5e5)] rounded transition-colors"
                  title="Edit workspace"
                >
                  <Pencil size={9} className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)]" />
                </button>
              )}

              {tab.closeable && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose?.(tab.id);
                  }}
                  className="p-0.5 hover:bg-[var(--color-background-alt,#e5e5e5)] rounded transition-colors"
                >
                  <X size={10} className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)]" />
                </button>
              )}
              {isActive && (
                <>
                  <div className="absolute -bottom-[1px] left-0 right-0 h-[1px] bg-[var(--color-surface,#ffffff)]" />
                  {/* Shard accent — active tab top indicator */}
                  <div className="absolute top-0 left-0 right-0 h-[3px] shard-start bg-[var(--color-accent,#ccff00)]" />
                </>
              )}

              {/* Edit Popover */}
              <Popover
                isOpen={isEditing}
                onClose={closeEdit}
                title="EDIT WORKSPACE"
                anchor="left"
                anchorEl={tabRefs.current[tab.id]}
              >
                <div className="space-y-3 min-w-[220px]">
                  {/* Name */}
                  <TextInput
                    label="Name"
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value.toUpperCase())}
                    autoFocus
                    compact
                  />

                  {/* Emoji */}
                  <div>
                    <label className="block font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] uppercase tracking-widest mb-1">
                      Emoji
                    </label>
                    <div className="flex flex-wrap gap-1">
                      <button
                        onClick={() => updateEmoji('')}
                        className={`w-6 h-6 border text-[10px] font-mono ${!editEmoji ? 'border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-surface-alt,#fafafa)]' : 'border-[var(--color-border,#d4d4d8)] hover:border-[var(--color-text-muted,#6b7280)]'}`}
                      >
                        ✕
                      </button>
                      {PRESET_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          onClick={() => updateEmoji(emoji)}
                          className={`w-6 h-6 border text-sm ${editEmoji === emoji ? 'border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-surface-alt,#fafafa)]' : 'border-[var(--color-border,#d4d4d8)] hover:border-[var(--color-text-muted,#6b7280)]'}`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Color */}
                  <div>
                    <label className="block font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] uppercase tracking-widest mb-1">
                      Color
                    </label>
                    <div className="flex flex-wrap gap-1">
                      {PRESET_COLORS.map((color) => (
                        <button
                          key={color}
                          onClick={() => updateColor(color)}
                          className={`w-6 h-6 border-2 ${editColor === color ? 'border-[var(--color-accent,#ccff00)]' : 'border-transparent'}`}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </Popover>
            </div>
          );
        })}
      </div>

      {/* New Tab Button */}
      {onNewTab && (
        <button
          onClick={onNewTab}
          className="ml-1 p-1.5 mb-1 hover:bg-[var(--color-surface-alt,#d8d8d6)] rounded transition-colors group"
          title="New Workspace"
        >
          <Plus size={14} className="text-[var(--color-text-muted,#6b7280)] group-hover:text-[var(--color-text,#0a0a0a)]" />
        </button>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Toolbar buttons */}
      <div className="flex items-center gap-0.5 mr-1 mb-1">
        {/* App Store */}
        {onAppStore && (
          <button
            onClick={onAppStore}
            className="p-1.5 hover:bg-[var(--color-surface,#ffffff)] rounded transition-colors group"
            title="App Store"
          >
            <LayoutGrid size={14} className="text-[var(--color-text-muted,#6b7280)] group-hover:text-[var(--color-text,#0a0a0a)]" />
          </button>
        )}

        {/* Tidy/Cleanup */}
        {onTidy && (
          <button
            onClick={onTidy}
            className="p-1.5 hover:bg-[var(--color-surface,#ffffff)] rounded transition-colors group"
            title="Tidy apps"
          >
            <Brush size={14} className="text-[var(--color-text-muted,#6b7280)] group-hover:text-[var(--color-text,#0a0a0a)]" />
          </button>
        )}

        {/* Notifications Bell + Drawer */}
        <NotificationDrawer
          notifications={notifications}
          onDismiss={onDismissNotification ?? (() => {})}
        />
      </div>
    </div>
  );
};
