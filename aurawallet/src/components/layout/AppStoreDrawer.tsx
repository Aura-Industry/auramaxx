'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { Box, Plus, Loader2, Shield, Check, Download } from 'lucide-react';
import { Drawer, Button, Popover, TextInput } from '@/components/design-system';
import { APP_TYPES, type AppDefinition } from '@/lib/app-registry';
import type { AppManifest } from '@/lib/app-loader';
import { api, Api } from '@/lib/api';

interface AppStoreDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onAddApp: (appType: string, config?: Record<string, unknown>) => void;
}

const CATEGORIES = [
  { id: 'all', label: 'ALL' },
  { id: 'builtin', label: 'BUILT-IN' },
  { id: 'installed', label: 'INSTALLED' },
];

export function AppStoreDrawer({ isOpen, onClose, onAddApp }: AppStoreDrawerProps) {
  const [manifests, setManifests] = useState<AppManifest[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState('all');

  // Install from URL state
  const [installSource, setInstallSource] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installSuccess, setInstallSuccess] = useState<string | null>(null);

  // Approval popover state
  const [approvalApp, setApprovalApp] = useState<AppManifest | null>(null);
  const [approvalAnchor, setApprovalAnchor] = useState<HTMLElement | null>(null);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  // Fetch third-party app manifests when drawer opens
  useEffect(() => {
    if (!isOpen) return;

    setLoading(true);
    api.get<{ success: boolean; manifests: AppManifest[] }>(Api.Workspace, '/apps/manifests')
      .then(data => {
        if (data.success) setManifests(data.manifests);
      })
      .catch(err => console.error('Failed to load app manifests:', err))
      .finally(() => setLoading(false));
  }, [isOpen]);

  // Close approval popover when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setApprovalApp(null);
      setApprovalAnchor(null);
    }
  }, [isOpen]);

  const refreshManifests = () => {
    api.get<{ success: boolean; manifests: AppManifest[] }>(Api.Workspace, '/apps/manifests')
      .then(data => {
        if (data.success) setManifests(data.manifests);
      })
      .catch(() => {});
  };

  const handleInstall = async () => {
    if (!installSource.trim()) return;
    setInstalling(true);
    setInstallError(null);
    setInstallSuccess(null);
    try {
      const result = await api.post<{ success: boolean; error?: string; app?: { id: string; name: string } }>(
        Api.Workspace, '/apps/install', { source: installSource.trim() }
      );
      if (!result.success) {
        setInstallError(result.error || 'Install failed');
        return;
      }
      setInstallSuccess(`Installed "${result.app?.name || result.app?.id}"`);
      setInstallSource('');
      refreshManifests();
    } catch (err) {
      setInstallError((err as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  const handleApprove = async () => {
    if (!approvalApp) return;
    setApproving(true);
    setApprovalError(null);
    try {
      const result = await api.post<{ success: boolean; error?: string }>(
        Api.Wallet, `/apps/${approvalApp.id}/approve`
      );
      if (!result.success) {
        setApprovalError(result.error || 'Approval failed');
        return;
      }
      const appId = approvalApp.id;
      const appName = approvalApp.name;
      setApprovalApp(null);
      setApprovalAnchor(null);
      onAddApp(`installed:${appId}`, { appPath: appId, appName });
    } catch (err) {
      setApprovalError((err as Error).message);
    } finally {
      setApproving(false);
    }
  };

  // Built-in apps as store cards
  const builtinCards = useMemo(() => {
    return Object.entries(APP_TYPES).map(([key, def]: [string, AppDefinition]) => ({
      id: key,
      name: def.title,
      icon: def.icon,
      description: def.description || `Built-in ${def.title.toLowerCase()} app`,
      category: 'builtin' as const,
      color: def.color,
      permissions: [] as string[],
      manifest: null as AppManifest | null,
      onAdd: () => onAddApp(key),
    }));
  }, [onAddApp]);

  // Installed (third-party) app cards
  const installedCards = useMemo(() => {
    return manifests.map(m => ({
      id: `installed:${m.id}`,
      name: m.name,
      icon: Box,
      description: m.description || `Installed app`,
      category: 'installed' as const,
      color: 'gray' as const,
      permissions: Array.isArray(m.permissions) ? m.permissions : [],
      manifest: m as AppManifest | null,
      onAdd: () => onAddApp(`installed:${m.id}`, { appPath: m.id, appName: m.name }),
    }));
  }, [manifests, onAddApp]);

  const allCards = useMemo(() => {
    if (activeCategory === 'builtin') return builtinCards;
    if (activeCategory === 'installed') return installedCards;
    return [...builtinCards, ...installedCards];
  }, [activeCategory, builtinCards, installedCards]);

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title="APP STORE"
      subtitle="Add apps to workspace"
    >
      <div className="space-y-4">
        {/* Category Filters */}
        <div className="flex gap-1">
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`px-2.5 py-1 font-mono text-[9px] tracking-widest border transition-colors ${
                activeCategory === cat.id
                  ? 'bg-[var(--color-text,#0a0a0a)] text-[var(--color-accent,#ccff00)] border-[var(--color-text,#0a0a0a)]'
                  : 'bg-[var(--color-surface,#fff)] text-[var(--color-text-muted,#6b7280)] border-[var(--color-border,#d4d4d8)] hover:border-[var(--color-text,#0a0a0a)]'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Install from URL */}
        {(activeCategory === 'all' || activeCategory === 'installed') && (
          <div className="p-2.5 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)]">
            <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] mb-1.5 tracking-wider">
              INSTALL FROM URL
            </div>
            <div className="flex gap-1.5">
              <div className="flex-1">
                <TextInput
                  value={installSource}
                  onChange={(e) => setInstallSource(e.target.value)}
                  placeholder="github.com/user/app or URL"
                  compact
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === 'Enter') handleInstall();
                  }}
                  disabled={installing}
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={handleInstall}
                loading={installing}
                disabled={installing || !installSource.trim()}
                icon={<Download size={10} />}
              >
                INSTALL
              </Button>
            </div>
            {installError && (
              <div className="font-mono text-[8px] text-[var(--color-warning,#ff4d00)] mt-1.5">
                {installError}
              </div>
            )}
            {installSuccess && (
              <div className="font-mono text-[8px] text-[var(--color-success,#22c55e)] mt-1.5">
                {installSuccess}
              </div>
            )}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="py-8 flex items-center justify-center">
            <Loader2 size={16} className="animate-spin text-[var(--color-text-muted,#6b7280)]" />
          </div>
        )}

        {/* App Grid */}
        {!loading && allCards.length === 0 && (
          <div className="py-8 text-center border border-dashed border-[var(--color-border,#d4d4d8)]">
            <Box size={20} className="mx-auto mb-2 text-[var(--color-text-faint,#9ca3af)]" />
            <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">
              {activeCategory === 'installed'
                ? 'No apps installed. Drop app folders into apps/'
                : 'No apps available'}
            </div>
          </div>
        )}

        {!loading && (
          <div className="space-y-2">
            {allCards.map(card => {
              const IconComponent = card.icon;
              const needsApproval = card.permissions.length > 0;

              return (
                <div
                  key={card.id}
                  className="p-3 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] hover:border-[var(--color-border-focus,#0a0a0a)] transition-colors relative"
                >
                  {/* Corner accents */}
                  <div className="absolute top-1 left-1 w-1.5 h-1.5 border-l border-t border-[var(--color-border-focus,#0a0a0a)] opacity-30" />
                  <div className="absolute top-1 right-1 w-1.5 h-1.5 border-r border-t border-[var(--color-border-focus,#0a0a0a)] opacity-30" />

                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 bg-[var(--color-background-alt,#f4f4f5)] flex items-center justify-center shrink-0">
                      <IconComponent size={14} className="text-[var(--color-text-muted,#6b7280)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] font-bold text-[var(--color-text,#0a0a0a)]">
                          {card.name}
                        </span>
                        <span className={`font-mono text-[7px] px-1 py-0.5 ${
                          card.category === 'installed'
                            ? 'bg-[var(--color-accent,#ccff00)]/20 text-[var(--color-accent,#ccff00)]'
                            : 'bg-[var(--color-info,#0047ff)]/10 text-[var(--color-info,#0047ff)]'
                        }`}>
                          {card.category === 'installed' ? 'PLUGIN' : 'BUILT-IN'}
                        </span>
                      </div>
                      <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] mt-0.5 leading-relaxed">
                        {card.description}
                      </div>
                      {needsApproval && (
                        <div className="flex items-center gap-1 mt-1">
                          <Shield size={8} className="text-[var(--color-warning,#ff4d00)]" />
                          <span className="font-mono text-[7px] text-[var(--color-warning,#ff4d00)]">
                            {card.permissions.length} PERMISSION{card.permissions.length > 1 ? 'S' : ''}
                          </span>
                        </div>
                      )}
                    </div>
                    <Button
                      variant={needsApproval ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                        if (needsApproval && card.manifest) {
                          setApprovalApp(card.manifest);
                          setApprovalAnchor(e.currentTarget);
                          setApprovalError(null);
                        } else {
                          card.onAdd();
                        }
                      }}
                      icon={needsApproval ? <Shield size={10} /> : <Plus size={10} />}
                    >
                      {needsApproval ? 'APPROVE' : 'ADD'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Approval Popover */}
        <Popover
          isOpen={!!approvalApp}
          onClose={() => { setApprovalApp(null); setApprovalAnchor(null); }}
          title="APP PERMISSIONS"
          anchorEl={approvalAnchor}
          anchor="right"
        >
          {approvalApp && (
            <div className="space-y-3 min-w-[220px]">
              <div>
                <div className="font-mono text-[10px] font-bold text-[var(--color-text,#0a0a0a)]">
                  {approvalApp.name}
                </div>
                <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] mt-0.5">
                  This app requests the following permissions:
                </div>
              </div>

              <div className="space-y-1">
                {(Array.isArray(approvalApp.permissions) ? approvalApp.permissions : []).map(perm => (
                  <div
                    key={perm}
                    className="flex items-center gap-1.5 px-2 py-1.5 bg-[var(--color-background-alt,#f4f4f5)]"
                  >
                    <Shield size={9} className="text-[var(--color-warning,#ff4d00)] shrink-0" />
                    <span className="font-mono text-[9px] text-[var(--color-text,#0a0a0a)]">{perm}</span>
                  </div>
                ))}
              </div>

              {approvalError && (
                <div className="font-mono text-[8px] text-[var(--color-warning,#ff4d00)] px-1">
                  {approvalError}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleApprove}
                  loading={approving}
                  disabled={approving}
                  icon={<Check size={10} />}
                  className="flex-1"
                >
                  APPROVE
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setApprovalApp(null); setApprovalAnchor(null); }}
                  disabled={approving}
                >
                  CANCEL
                </Button>
              </div>
            </div>
          )}
        </Popover>
      </div>
    </Drawer>
  );
}
