'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { KeyRound, Flame, Shield, ShieldCheck, Database, MessageCircle, Globe, Users, Menu, Plus, Star, Trash2 } from 'lucide-react';
import type { ViewDefinition } from '@/lib/view-registry';
import type { HubSubscriptionInfo } from '@/lib/social-client';
import { Popover } from '@/components/design-system';

const ICON_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  KeyRound,
  Flame,
  Shield,
  ShieldCheck,
  Database,
  MessageCircle,
  Globe,
  Users,
};

interface LeftRailProps {
  views: ViewDefinition[];
  activeViewId: string;
  onSelectView: (id: string) => void;
  onCreateView?: () => void;
  // Hub multi-server support
  hubs?: HubSubscriptionInfo[];
  activeHubUrl?: string;
  onSelectHub?: (hubUrl: string) => void;
  favoriteHubUrls?: string[];
  nonRemovableHubUrls?: string[];
  onToggleHubFavorite?: (hub: HubSubscriptionInfo) => void | Promise<void>;
  onRemoveHub?: (hub: HubSubscriptionInfo) => void | Promise<void>;
  onAddHub?: () => void;
}

function useIsTablet(): boolean {
  const [isTablet, setIsTablet] = useState(false);
  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      setIsTablet(w >= 768 && w < 1280);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return isTablet;
}

/** Extract a display initial from a hub label or URL. */
function hubInitial(hub: HubSubscriptionInfo): string {
  if (hub.label) return hub.label[0].toUpperCase();
  try {
    const hostname = new URL(hub.hubUrl).hostname;
    return hostname[0].toUpperCase();
  } catch {
    return '?';
  }
}

function normalizeHubUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function LeftRail({
  views,
  activeViewId,
  onSelectView,
  hubs,
  activeHubUrl,
  onSelectHub,
  favoriteHubUrls,
  nonRemovableHubUrls,
  onToggleHubFavorite,
  onRemoveHub,
  onAddHub,
}: LeftRailProps) {
  const isTablet = useIsTablet();
  const showHubs = (activeViewId === 'social' || activeViewId === 'hub') && hubs && hubs.length > 0;
  const [hubMenuAnchorEl, setHubMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [hubMenuHubUrl, setHubMenuHubUrl] = useState<string | null>(null);

  const favoriteHubUrlSet = useMemo(
    () => new Set((favoriteHubUrls ?? []).map((url) => normalizeHubUrl(url)).filter(Boolean)),
    [favoriteHubUrls],
  );
  const nonRemovableHubUrlSet = useMemo(
    () => new Set((nonRemovableHubUrls ?? []).map((url) => normalizeHubUrl(url)).filter(Boolean)),
    [nonRemovableHubUrls],
  );

  const sortedHubs = useMemo(() => {
    if (!hubs || hubs.length === 0) return [];
    const favorites: HubSubscriptionInfo[] = [];
    const others: HubSubscriptionInfo[] = [];
    for (const hub of hubs) {
      if (favoriteHubUrlSet.has(normalizeHubUrl(hub.hubUrl))) {
        favorites.push(hub);
      } else {
        others.push(hub);
      }
    }
    return [...favorites, ...others];
  }, [hubs, favoriteHubUrlSet]);

  const hubMenuHub = useMemo(
    () => sortedHubs.find((hub) => hub.hubUrl === hubMenuHubUrl) ?? null,
    [sortedHubs, hubMenuHubUrl],
  );

  const closeHubMenu = useCallback(() => {
    setHubMenuAnchorEl(null);
    setHubMenuHubUrl(null);
  }, []);

  useEffect(() => {
    if (!hubMenuHubUrl) return;
    if (sortedHubs.some((hub) => hub.hubUrl === hubMenuHubUrl)) return;
    closeHubMenu();
  }, [hubMenuHubUrl, sortedHubs, closeHubMenu]);

  return (
    <div
      className="relative overflow-hidden"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '8px',
        padding: '12px 6px',
        width: '56px',
        minWidth: '56px',
        borderRight: '1px solid var(--color-border, #d4d4d8)',
        background: 'var(--color-surface, #f4f4f2)',
        height: '100%',
        zIndex: 10,
      }}
    >
      {/* Dot texture (matches AgentSidebar) */}
      <div className="absolute inset-0 opacity-[0.02] pointer-events-none bg-[radial-gradient(var(--color-text,#000)_1px,transparent_1px)] bg-[size:4px_4px]" />

      {/* Logo */}
      <img
        src="/logo.webp"
        alt="Aura"
        style={{
          width: '28px',
          height: '28px',
          objectFit: 'contain',
          marginBottom: '4px',
          position: 'relative',
        }}
      />

      {/* Separator */}
      <div style={{ width: '24px', height: '1px', background: 'var(--color-border, #d4d4d8)', position: 'relative' }} />

      {/* View buttons */}
      {views.map((view) => {
        const Icon = ICON_MAP[view.icon] || KeyRound;
        const isActive = view.id === activeViewId;

        return (
          <button
            key={view.id}
            onClick={() => onSelectView(view.id)}
            title={view.label}
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '12px',
              border: 'none',
              background: isActive
                ? 'var(--color-accent, #6366f1)'
                : 'transparent',
              color: isActive
                ? 'var(--color-accent-foreground, #0a0a0a)'
                : 'var(--color-text-muted, #6b7280)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s ease',
              position: 'relative',
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLElement).style.background = 'var(--color-border, #d4d4d8)';
                (e.currentTarget as HTMLElement).style.color = 'var(--color-text, #0a0a0a)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLElement).style.background = 'transparent';
                (e.currentTarget as HTMLElement).style.color = 'var(--color-text-muted, #6b7280)';
              }
            }}
          >
            <Icon size={20} />
          </button>
        );
      })}

      {/* Hub server list — shown when social view is active */}
      {showHubs && (
        <>
          <div style={{ width: '24px', height: '1px', background: 'var(--color-border, #d4d4d8)', position: 'relative' }} />
          {sortedHubs.map((hub) => {
            const isActive = hub.hubUrl === activeHubUrl;
            const normalizedHubUrl = normalizeHubUrl(hub.hubUrl);
            const isFavorite = favoriteHubUrlSet.has(normalizedHubUrl);
            return (
              <button
                key={hub.hubUrl}
                onClick={() => {
                  closeHubMenu();
                  onSelectHub?.(hub.hubUrl);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setHubMenuAnchorEl(e.currentTarget);
                  setHubMenuHubUrl(hub.hubUrl);
                }}
                title={hub.label || hub.hubUrl}
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '50%',
                  border: isActive
                    ? '2px solid var(--color-accent, #6366f1)'
                    : isFavorite
                      ? '1px solid var(--color-accent, #6366f1)'
                      : '1px solid var(--color-border, #d4d4d8)',
                  background: isActive ? 'var(--color-accent, #6366f1)' : 'var(--color-surface, #f4f4f2)',
                  color: isActive ? 'var(--color-accent-foreground, #ffffff)' : 'var(--color-text, #0a0a0a)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono, monospace)',
                  transition: 'all 0.15s ease',
                  position: 'relative',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent, #6366f1)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border, #d4d4d8)';
                  }
                }}
              >
                {hubInitial(hub)}
                {isFavorite && !isActive && (
                  <span
                    style={{
                      position: 'absolute',
                      top: '-3px',
                      right: '-3px',
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      background: 'var(--color-surface, #f4f4f2)',
                      border: '1px solid var(--color-accent, #6366f1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Star size={8} fill="var(--color-accent, #6366f1)" color="var(--color-accent, #6366f1)" />
                  </span>
                )}
              </button>
            );
          })}
        </>
      )}

      {/* Add Server button — shown when social view is active */}
      {onAddHub && (
        <button
          onClick={onAddHub}
          title="Add Server"
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            border: '1px dashed var(--color-border, #d4d4d8)',
            background: 'transparent',
            color: 'var(--color-text-muted, #6b7280)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.15s ease',
            position: 'relative',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent, #6366f1)';
            (e.currentTarget as HTMLElement).style.color = 'var(--color-accent, #6366f1)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border, #d4d4d8)';
            (e.currentTarget as HTMLElement).style.color = 'var(--color-text-muted, #6b7280)';
          }}
        >
          <Plus size={16} />
        </button>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Hamburger menu — tablet only */}
      {isTablet && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('leftrail:menu-toggle'))}
          title="Open sidebar"
          aria-label="Open sidebar"
          style={{
            width: '40px',
            height: '40px',
            borderRadius: '12px',
            border: 'none',
            background: 'transparent',
            color: 'var(--color-text-muted, #6b7280)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.15s ease',
            position: 'relative',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'var(--color-border, #d4d4d8)';
            (e.currentTarget as HTMLElement).style.color = 'var(--color-text, #0a0a0a)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'transparent';
            (e.currentTarget as HTMLElement).style.color = 'var(--color-text-muted, #6b7280)';
          }}
        >
          <Menu size={20} />
        </button>
      )}

      <Popover
        isOpen={Boolean(hubMenuHub && hubMenuAnchorEl)}
        onClose={closeHubMenu}
        title="HUB ACTIONS"
        anchor="left"
        anchorEl={hubMenuAnchorEl}
      >
        {hubMenuHub && (
          <div className="min-w-[160px] space-y-1">
            <button
              type="button"
              className="w-full flex items-center gap-2 px-2 py-1.5 border border-transparent hover:border-[var(--color-border,#d4d4d8)] text-left text-[11px] font-mono tracking-wide"
              onClick={() => {
                if (onToggleHubFavorite) {
                  void onToggleHubFavorite(hubMenuHub);
                }
                closeHubMenu();
              }}
            >
              <Star
                size={13}
                className="text-[var(--color-text,#0a0a0a)]"
                fill={favoriteHubUrlSet.has(normalizeHubUrl(hubMenuHub.hubUrl)) ? 'currentColor' : 'none'}
              />
              {favoriteHubUrlSet.has(normalizeHubUrl(hubMenuHub.hubUrl)) ? 'Unfavorite' : 'Favorite'}
            </button>
            <button
              type="button"
              className={`w-full flex items-center gap-2 px-2 py-1.5 border text-left text-[11px] font-mono tracking-wide text-[var(--color-danger,#dc2626)] ${
                nonRemovableHubUrlSet.has(normalizeHubUrl(hubMenuHub.hubUrl))
                  ? 'border-transparent opacity-50 cursor-not-allowed'
                  : 'border-transparent hover:border-[var(--color-border,#d4d4d8)]'
              }`}
              disabled={nonRemovableHubUrlSet.has(normalizeHubUrl(hubMenuHub.hubUrl))}
              onClick={() => {
                if (onRemoveHub) {
                  void onRemoveHub(hubMenuHub);
                }
                closeHubMenu();
              }}
            >
              <Trash2 size={13} />
              Delete
            </button>
            {nonRemovableHubUrlSet.has(normalizeHubUrl(hubMenuHub.hubUrl)) && (
              <p className="px-2 pt-1 text-[10px] font-mono text-[var(--color-text-muted,#6b7280)]">
                Default hub cannot be removed.
              </p>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}
