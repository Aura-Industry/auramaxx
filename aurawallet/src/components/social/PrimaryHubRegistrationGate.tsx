'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, Loader2, User } from 'lucide-react';
import { api, Api } from '@/lib/api';
import { Button, TextInput } from '@/components/design-system';
import { fetchSocialProfile } from '@/lib/social-client';
import type { AgentProfile } from '@/lib/social-client';
import { AgentPfp } from '@/components/AgentPicker';

const DEFAULT_AGENT_AVATAR = 'https://aurawallet.sh/agent7.png';
const SPRITE_OPTIONS = Array.from({ length: 10 }, (_, i) => `/agent${i + 1}.png`);

interface PrimaryHubStatus {
  agentId: string;
  auraId: number | null;
  registered: boolean;
  hasPublicKey: boolean;
}

interface AgentInfo {
  id: string;
  isPrimary: boolean;
  parentAgentId?: string;
}

interface PrimaryHubRegistrationGateProps {
  children: React.ReactNode;
}

function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').replace(/\s+/g, '');
}

function normalizeSpritePfp(pfp: string | undefined): string {
  const value = (pfp || '').trim();
  if (/\/agent\d+\.png$/.test(value)) return value.startsWith('http') ? value : `https://aurawallet.sh${value}`;
  return DEFAULT_AGENT_AVATAR;
}

export function PrimaryHubRegistrationGate({ children }: PrimaryHubRegistrationGateProps) {
  const [loading, setLoading] = useState(true);
  const [agentId, setAgentId] = useState<string>('');
  const [registered, setRegistered] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const [selectedPfp, setSelectedPfp] = useState<string>(DEFAULT_AGENT_AVATAR);
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setStatusError(null);
    try {
      const agentsRes = await api.get<{ agents: AgentInfo[] }>(Api.Wallet, '/agents/credential');
      const agents = agentsRes.agents || [];
      const primary = agents.find((agent) => agent.isPrimary && !agent.parentAgentId)
        ?? agents.find((agent) => agent.isPrimary)
        ?? agents[0];

      if (!primary?.id) {
        throw new Error('Primary agent not found');
      }

      setAgentId(primary.id);

      const [statusRes, profileRes] = await Promise.allSettled([
        api.get<PrimaryHubStatus>(Api.Wallet, `/agent-hub/${encodeURIComponent(primary.id)}/status`),
        fetchSocialProfile(primary.id),
      ]);

      if (statusRes.status === 'fulfilled') {
        setRegistered(statusRes.value.registered === true);
      } else {
        setRegistered(false);
      }

      const profile: AgentProfile = profileRes.status === 'fulfilled'
        ? profileRes.value
        : { pfp: DEFAULT_AGENT_AVATAR, handle: '', displayName: '' };

      setSelectedPfp(normalizeSpritePfp(profile.pfp));
      setHandle(normalizeHandle(profile.handle || ''));
      setDisplayName((profile.displayName || '').trim());
    } catch (error) {
      setRegistered(false);
      setStatusError(error instanceof Error ? error.message : 'Failed to load primary hub registration status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const canSubmit = useMemo(
    () => Boolean(agentId && normalizeHandle(handle) && displayName.trim()),
    [agentId, handle, displayName],
  );

  const handleRegister = useCallback(async () => {
    if (!agentId || registering) return;
    const normalizedHandle = normalizeHandle(handle);
    const normalizedDisplayName = displayName.trim();
    if (!normalizedHandle || !normalizedDisplayName) {
      setRegisterError('Username and display name are required.');
      return;
    }

    setRegistering(true);
    setRegisterError(null);

    try {
      await api.post(Api.Wallet, `/agent-hub/${encodeURIComponent(agentId)}/register`, {});

      const updates: Array<{ field: string; value: string }> = [
        { field: 'handle', value: normalizedHandle },
        { field: 'display_name', value: normalizedDisplayName },
        { field: 'pfp', value: selectedPfp },
        { field: 'pfp_is_sprite', value: 'true' },
      ];

      for (const update of updates) {
        await api.post<{ success?: boolean; error?: string }>(
          Api.Wallet,
          '/social/profile',
          { agentId, field: update.field, value: update.value },
        );
      }

      await loadStatus();
    } catch (error) {
      setRegisterError(error instanceof Error ? error.message : 'Failed to register on primary hub');
    } finally {
      setRegistering(false);
    }
  }, [agentId, displayName, handle, loadStatus, registering, selectedPfp]);

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <Loader2 size={18} className="animate-spin text-[var(--color-text-muted,#6b7280)]" />
      </div>
    );
  }

  if (registered) {
    return <>{children}</>;
  }

  return (
    <div className="h-full w-full flex items-center justify-center p-6 bg-[var(--color-background,#f4f4f5)]">
      <div className="w-full max-w-[440px] bg-[var(--color-surface,#f4f4f2)] clip-specimen border-mech shadow-mech overflow-hidden font-mono">
        <div className="px-5 py-3 border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] flex items-center justify-between">
          <span className="font-sans font-bold text-sm text-[var(--color-text,#0a0a0a)] uppercase tracking-tight">
            Register Agent
          </span>
          <span className="text-[9px] text-[var(--color-text-faint,#9ca3af)] font-bold tracking-widest uppercase inline-flex items-center gap-1">
            <Lock size={10} />
            Locked
          </span>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            <AgentPfp src={selectedPfp} isSprite={true} fallbackLetter="A" size="lg" />
            <div>
              <div className="text-[12px] font-semibold text-[var(--color-text,#0a0a0a)]">
                Register your primary agent
              </div>
              <div className="text-[10px] text-[var(--color-text-muted,#6b7280)]">
                Credentials and Social use the primary hub from Settings.
              </div>
            </div>
          </div>

          <div>
            <label className="block text-[9px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] mb-2">
              Profile Image
            </label>
            <div className="grid grid-cols-5 gap-2">
              {SPRITE_OPTIONS.map((src, index) => {
                const spriteUrl = `https://aurawallet.sh${src}`;
                const selected = selectedPfp === spriteUrl;
                return (
                  <button
                    key={src}
                    type="button"
                    onClick={() => setSelectedPfp(spriteUrl)}
                    className={`rounded border transition-colors ${
                      selected
                        ? 'border-[var(--color-accent,#6366f1)]'
                        : 'border-[var(--color-border,#d4d4d8)] hover:border-[var(--color-text-muted,#6b7280)]'
                    }`}
                    style={{ padding: '4px 2px' }}
                  >
                    <div
                      className="yo-sprite"
                      style={{
                        backgroundImage: `url('${src}')`,
                        animation: 'yo-sprite-frames 0.9s steps(1, end) infinite',
                        animationDelay: `${index * -150}ms`,
                        width: '28px',
                        height: '40px',
                        margin: '0 auto',
                      }}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          <TextInput
            label="Username"
            compact
            placeholder="@myhandle"
            value={handle}
            onChange={(event) => {
              setHandle(event.target.value);
              setRegisterError(null);
            }}
            leftElement={<User size={12} />}
          />

          <TextInput
            label="Display Name"
            compact
            placeholder="My Display Name"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setRegisterError(null);
            }}
          />

          {(statusError || registerError) && (
            <div className="text-[10px] text-[var(--color-danger,#ef4444)] bg-[var(--color-danger,#ef4444)]/10 px-3 py-2 border border-[var(--color-danger,#ef4444)]/20">
              {registerError || statusError}
            </div>
          )}

          <Button
            variant="primary"
            size="sm"
            className="w-full"
            onClick={() => { void handleRegister(); }}
            loading={registering}
            disabled={!canSubmit}
          >
            REGISTER AGENT
          </Button>
        </div>
      </div>
    </div>
  );
}
