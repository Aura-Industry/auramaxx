'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, MessageSquare, RotateCcw, Save, X, KeyRound, ExternalLink } from 'lucide-react';
import { api, Api } from '@/lib/api';
import { Button, TextInput } from '@/components/design-system';

type DefaultType = 'permissions' | 'financial' | 'swap' | 'ttl' | 'rate_limit' | 'ai_safety' | 'launch' | 'app';

interface DefaultItem {
  key: string;
  value: unknown;
  type: DefaultType | string;
  label: string;
  description: string | null;
  updatedAt: string;
}

interface DefaultsResponse {
  success: boolean;
  defaults: Record<string, DefaultItem[]>;
}

interface ProviderInfo {
  mode: string;
  label: string;
  available: boolean;
  reason: string;
  models: string[];
}

interface AiTiers {
  fast: string;
  standard: string;
  powerful: string;
}

interface AiStatusResponse {
  activeProvider: string;
  tiers: AiTiers;
  providers: ProviderInfo[];
}

const KNOWN_PERMISSIONS = [
  'wallet:create:hot',
  'send:hot',
  'swap',
  'fund',
  'action:create',
];

const EDITABLE_KEYS = [
  'limits.fund',
  'limits.send',
  'limits.swap',
  'swap.max_slippage',
  'swap.min_slippage_admin',
  'swap.min_slippage_agent',
  'permissions.default',
] as const;

const SUFFIX_BY_KEY: Partial<Record<(typeof EDITABLE_KEYS)[number], string>> = {
  'limits.fund': 'ETH',
  'limits.send': 'ETH',
  'limits.swap': 'ETH',
  'swap.max_slippage': '%',
  'swap.min_slippage_admin': '%',
  'swap.min_slippage_agent': '%',
};

/** Tier labels for display */
const TIER_LABELS: Record<string, string> = {
  fast: 'Fast',
  standard: 'Standard',
  powerful: 'Powerful',
};

/** Map provider mode to the API key service name it requires (if any) */
const PROVIDER_KEY_SERVICE: Record<string, string | null> = {
  'claude-cli': null,
  'claude-api': 'anthropic',
  'codex-cli': null,
  'openai-api': 'openai',
};

/** Human-readable label for API key services */
const KEY_SERVICE_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

function formatInputValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return '';
}

// ─── AI Engine Section ─────────────────────────────────────────────

export function AiEngineSection() {
  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(true);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiMessage, setAiMessage] = useState<string | null>(null);

  // Draft state (local until SAVE)
  const [draftProvider, setDraftProvider] = useState<string>('claude-cli');

  // API key inline form
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyValidating, setKeyValidating] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySaved, setKeySaved] = useState(false);

  const loadAiStatus = useCallback(async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await api.get<AiStatusResponse>(Api.Wallet, '/ai/status');
      setAiStatus(res);
      setDraftProvider(res.activeProvider);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Failed to load AI status');
    } finally {
      setAiLoading(false);
    }
  }, []);

  useEffect(() => { void loadAiStatus(); }, [loadAiStatus]);

  // Get current provider info
  const selectedProvider = aiStatus?.providers.find(p => p.mode === draftProvider);

  const handleProviderChange = (mode: string) => {
    setDraftProvider(mode);
    setShowKeyForm(false);
    setKeyInput('');
    setKeyError(null);
    setKeySaved(false);
  };

  // Check if selected provider needs a key that isn't configured
  const keyService = PROVIDER_KEY_SERVICE[draftProvider];
  const needsKey = keyService && !selectedProvider?.available;

  const onSaveAi = async () => {
    setAiSaving(true);
    setAiError(null);
    setAiMessage(null);
    try {
      await api.patch(Api.Wallet, `/defaults/${encodeURIComponent('ai.provider')}`, { value: draftProvider });
      setAiMessage('AI settings saved');
      await loadAiStatus();
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Failed to save AI settings');
    } finally {
      setAiSaving(false);
    }
  };

  const onResetAi = async () => {
    setAiSaving(true);
    setAiError(null);
    setAiMessage(null);
    try {
      await api.post(Api.Wallet, '/defaults/reset', { key: 'ai.provider' });
      setAiMessage('AI settings reset to defaults');
      await loadAiStatus();
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Failed to reset AI settings');
    } finally {
      setAiSaving(false);
    }
  };

  const onValidateKey = async () => {
    if (!keyService || !keyInput.trim()) return;
    setKeyValidating(true);
    setKeyError(null);
    setKeySaved(false);
    try {
      const res = await api.post<{ valid: boolean; error?: string }>(Api.Wallet, '/apikeys/validate', {
        service: keyService,
        key: keyInput.trim(),
      });
      if (res.valid) {
        // Save the key
        await api.post(Api.Wallet, '/apikeys', {
          service: keyService,
          name: 'default',
          key: keyInput.trim(),
        });
        setKeySaved(true);
        setKeyInput('');
        setShowKeyForm(false);
        // Refresh status to show updated availability
        await loadAiStatus();
      } else {
        setKeyError(res.error || 'Invalid API key');
      }
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Validation failed');
    } finally {
      setKeyValidating(false);
    }
  };

  if (aiLoading) {
    return (
      <div className="p-2 space-y-2" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
        <div className="font-mono text-[10px] tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
          AI ENGINE
        </div>
        <div className="py-4 flex items-center justify-center">
          <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 space-y-2" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
      <div>
        <div className="font-mono text-[10px] tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
          AI ENGINE
        </div>
        <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-muted)' }}>
          Select AI provider and default model for hooks and strategies.
        </div>
      </div>

      {aiError && (
        <div className="p-1.5 font-mono text-[9px]" style={{ border: '1px solid var(--color-warning)', color: 'var(--color-warning)' }}>
          {aiError}
        </div>
      )}
      {aiMessage && (
        <div className="p-1.5 font-mono text-[9px]" style={{ border: '1px solid var(--color-success)', color: 'var(--color-success)' }}>
          {aiMessage}
        </div>
      )}

      {/* Provider radio buttons */}
      <div className="space-y-1">
        <div className="font-mono text-[9px] font-bold" style={{ color: 'var(--color-text)' }}>Provider</div>
        {aiStatus?.providers.map((p) => (
          <label
            key={p.mode}
            className="flex items-center gap-2 cursor-pointer py-1 px-1.5"
            style={{
              border: draftProvider === p.mode ? '1px solid var(--color-accent, #ccff00)' : '1px solid transparent',
              background: draftProvider === p.mode ? 'var(--color-background-alt, #f4f4f5)' : 'transparent',
            }}
          >
            <input
              type="radio"
              name="ai-provider"
              value={p.mode}
              checked={draftProvider === p.mode}
              onChange={() => handleProviderChange(p.mode)}
              className="accent-[var(--color-accent,#ccff00)]"
            />
            <span className="font-mono text-[9px] flex-1" style={{ color: 'var(--color-text)' }}>
              {p.label}
            </span>
            {p.available ? (
              <Check size={10} style={{ color: 'var(--color-success, #22c55e)' }} />
            ) : (
              <X size={10} style={{ color: 'var(--color-text-muted)' }} />
            )}
            <span className="font-mono text-[8px]" style={{ color: 'var(--color-text-muted)' }}>
              {p.available ? '' : p.reason}
            </span>
          </label>
        ))}
      </div>

      {/* API key warning + inline form */}
      {needsKey && keyService && (
        <div className="space-y-1.5">
          <div className="p-1.5 font-mono text-[9px] flex items-center gap-1.5" style={{ border: '1px solid var(--color-warning)', color: 'var(--color-warning)' }}>
            No {KEY_SERVICE_LABEL[keyService] || keyService} API key configured.
            {!showKeyForm && (
              <button
                onClick={() => setShowKeyForm(true)}
                className="font-bold underline ml-1"
                style={{ color: 'var(--color-warning)' }}
              >
                Add API Key
              </button>
            )}
          </div>
          {showKeyForm && (
            <div className="flex items-end gap-1.5">
              <div className="flex-1">
                <TextInput
                  label={`${KEY_SERVICE_LABEL[keyService] || keyService} API Key`}
                  compact
                  value={keyInput}
                  onChange={(e) => { setKeyInput(e.target.value); setKeyError(null); }}
                  rightElement={<KeyRound size={10} style={{ color: 'var(--color-text-muted)' }} />}
                />
              </div>
              <Button size="sm" onClick={() => void onValidateKey()} loading={keyValidating} disabled={!keyInput.trim()}>
                VALIDATE
              </Button>
            </div>
          )}
          {keyError && (
            <div className="font-mono text-[8px]" style={{ color: 'var(--color-warning)' }}>{keyError}</div>
          )}
          {keySaved && (
            <div className="font-mono text-[8px]" style={{ color: 'var(--color-success)' }}>API key saved successfully</div>
          )}
        </div>
      )}

      {/* Tier-based model display */}
      {aiStatus?.tiers && (
        <div className="space-y-0.5">
          <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted)' }}>Model Tiers (auto-selected by permissions):</div>
          {(['fast', 'standard', 'powerful'] as const).map((tier) => (
            <div key={tier} className="flex items-center gap-2 pl-1">
              <span className="font-mono text-[8px] w-14" style={{ color: 'var(--color-text-muted)' }}>{TIER_LABELS[tier]}:</span>
              <span className="font-mono text-[9px] font-bold" style={{ color: 'var(--color-text)' }}>
                {aiStatus.tiers[tier]}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Save / Reset */}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void onSaveAi()} loading={aiSaving} icon={<Save size={11} />}>
          SAVE
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void onResetAi()} disabled={aiSaving} icon={<RotateCcw size={11} />}>
          RESET
        </Button>
      </div>
    </div>
  );
}

// ─── Adapter Chat Section ──────────────────────────────────────────

interface AdapterInfo {
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  chat?: { enabled?: boolean };
  hasSecrets: boolean;
  secretKeys: string[];
}

interface AdaptersResponse {
  success: boolean;
  enabled: boolean;
  chat?: { defaultApp?: string };
  adapters: AdapterInfo[];
  running: boolean;
}

/** Which secret keys each adapter type requires for chat to work */
const REQUIRED_SECRETS: Record<string, string[]> = {
  telegram: ['botToken'],
};

function AdapterChatSection() {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [routerRunning, setRouterRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingType, setTogglingType] = useState<string | null>(null);

  // Chat ID auto-detection state
  const [detectingType, setDetectingType] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState('');
  const [, setSetupToken] = useState('');
  const [botUsername, setBotUsername] = useState('');
  const detectAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => { detectAbortRef.current?.abort(); };
  }, []);

  const loadAdapters = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<AdaptersResponse>(Api.Wallet, '/adapters');
      setAdapters(res.adapters || []);
      setRouterRunning(res.running);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load adapters');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAdapters(); }, [loadAdapters]);

  /** Check if an adapter has all required secrets configured */
  const hasMissingSecrets = (adapter: AdapterInfo): boolean => {
    const required = REQUIRED_SECRETS[adapter.type];
    if (!required) return false;
    return required.some(key => !adapter.secretKeys.includes(key));
  };

  /** Start auto-detection flow for missing chatId */
  const startChatIdDetection = async (adapter: AdapterInfo) => {
    setDetectingType(adapter.type);
    setError(null);
    try {
      const linkResult = await api.post<{ success: boolean; link: string; setupToken: string; botUsername: string; error?: string }>(Api.Wallet, '/adapters/telegram/setup-link', {});
      if (!linkResult.success) {
        setError(linkResult.error || 'Failed to generate setup link');
        setDetectingType(null);
        return;
      }
      setDeepLink(linkResult.link);
      setSetupToken(linkResult.setupToken);
      setBotUsername(linkResult.botUsername);

      // Poll for detection
      const abort = new AbortController();
      detectAbortRef.current = abort;

      for (let attempt = 0; attempt < 2; attempt++) {
        if (abort.signal.aborted) return;
        try {
          const result = await api.post<{ chatId: string | null; firstName?: string; username?: string; timeout?: boolean }>(Api.Wallet, '/adapters/telegram/detect-chat', { setupToken: linkResult.setupToken });
          if (abort.signal.aborted) return;

          if (result.chatId) {
            // Save config with detected chatId and enable chat
            await api.post(Api.Wallet, '/adapters', {
              type: adapter.type,
              enabled: adapter.enabled,
              config: { ...adapter.config, chatId: result.chatId },
              chat: { enabled: true },
            });
            await api.post(Api.Wallet, '/adapters/restart');
            try {
              await api.post(Api.Wallet, '/adapters/test', { type: adapter.type });
            } catch { /* non-critical */ }
            setDetectingType(null);
            setDeepLink('');
            await loadAdapters();
            return;
          }
        } catch {
          if (abort.signal.aborted) return;
          break;
        }
      }

      // Timed out
      if (!abort.signal.aborted) {
        setError('Auto-detection timed out. Re-configure Telegram in the Setup Wizard to set your chat ID.');
        setDetectingType(null);
        setDeepLink('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start detection');
      setDetectingType(null);
    }
  };

  const cancelDetection = () => {
    detectAbortRef.current?.abort();
    setDetectingType(null);
    setDeepLink('');
  };

  const toggleChat = async (adapter: AdapterInfo) => {
    const newChatEnabled = !adapter.chat?.enabled;

    // When enabling chat for telegram, check if chatId is missing
    if (newChatEnabled && adapter.type === 'telegram' && !adapter.config?.chatId) {
      await startChatIdDetection(adapter);
      return;
    }

    setTogglingType(adapter.type);
    setError(null);
    try {
      // Preserve existing config — POST /adapters replaces the full entry
      await api.post(Api.Wallet, '/adapters', {
        type: adapter.type,
        enabled: adapter.enabled,
        config: adapter.config,
        chat: { enabled: newChatEnabled },
      });
      // Restart the router so the running adapter picks up the change
      await api.post(Api.Wallet, '/adapters/restart');
      // Send a notification via the bot so the human knows chat is active
      if (newChatEnabled) {
        try {
          await api.post(Api.Wallet, '/adapters/test', { type: adapter.type });
        } catch {
          // Non-critical — toggle still succeeded
        }
      }
      await loadAdapters();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle chat');
    } finally {
      setTogglingType(null);
    }
  };


  if (loading) {
    return (
      <div className="p-2 space-y-2" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
        <div className="font-mono text-[10px] tracking-widest flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          <MessageSquare size={10} />
          ADAPTER CHAT
        </div>
        <div className="py-3 flex items-center justify-center">
          <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
        </div>
      </div>
    );
  }

  const enabledAdapters = adapters.filter(a => a.enabled);
  const anyChatEnabled = enabledAdapters.some(a => a.chat?.enabled === true);

  return (
    <div className="p-2 space-y-2" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
      <div>
        <div className="font-mono text-[10px] tracking-widest flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
          <MessageSquare size={10} />
          ADAPTER CHAT
        </div>
        <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-muted)' }}>
          Allow AI to respond to messages via external adapters.
        </div>
      </div>

      {error && (
        <div className="p-1.5 font-mono text-[9px]" style={{ border: '1px solid var(--color-warning)', color: 'var(--color-warning)' }}>
          {error}
        </div>
      )}

      {/* Chat ID auto-detection inline UI */}
      {detectingType && deepLink && (
        <div className="p-2 space-y-2" style={{ border: '1px solid var(--color-accent)', background: 'var(--color-background-alt)' }}>
          <Button variant="secondary" size="sm" icon={<ExternalLink size={10} />}
            onClick={() => window.open(deepLink, '_blank')}>
            Open @{botUsername} in Telegram
          </Button>
          <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-faint)' }}>
            Click the link above, then press Start in Telegram to detect your chat ID.
          </div>
          <div className="flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" style={{ color: 'var(--color-info)' }} />
            <span className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted)' }}>Waiting for you to press Start...</span>
          </div>
          <button
            onClick={cancelDetection}
            className="font-mono text-[8px] underline"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Cancel
          </button>
        </div>
      )}

      {!routerRunning && anyChatEnabled && (
        <div className="p-1.5 font-mono text-[8px]" style={{ border: '1px solid var(--color-warning)', color: 'var(--color-warning)' }}>
          Router not running. Restart the server or toggle an adapter to start it.
        </div>
      )}

      {enabledAdapters.length === 0 ? (
        <div className="py-3 text-center font-mono text-[9px]" style={{ color: 'var(--color-text-muted)' }}>
          No adapters configured. Add one via the API or CLI.
        </div>
      ) : (
        <div className="space-y-1">
          {enabledAdapters.map((adapter) => {
            const chatOn = adapter.chat?.enabled === true;
            const toggling = togglingType === adapter.type;
            const missingSecrets = hasMissingSecrets(adapter);
            return (
              <div key={adapter.type}>
                <div
                  className="flex items-center justify-between py-1.5 px-2"
                  style={{ border: '1px solid var(--color-border)', background: 'var(--color-background-alt)' }}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] font-bold uppercase" style={{ color: 'var(--color-text)' }}>
                      {adapter.type}
                    </span>
                    <span
                      className="font-mono text-[8px] px-1 py-0.5 rounded"
                      style={{
                        background: chatOn ? 'color-mix(in srgb, var(--color-success) 20%, transparent)' : 'color-mix(in srgb, var(--color-text-muted) 20%, transparent)',
                        color: chatOn ? 'var(--color-success)' : 'var(--color-text-muted)',
                      }}
                    >
                      {chatOn ? 'CHAT ON' : 'CHAT OFF'}
                    </span>
                  </div>
                  <button
                    onClick={() => void toggleChat(adapter)}
                    disabled={toggling || missingSecrets}
                    className="relative w-8 h-4 rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      background: chatOn ? 'var(--color-success, #22c55e)' : 'var(--color-border, #d4d4d8)',
                    }}
                  >
                    <div
                      className="absolute top-0.5 w-3 h-3 rounded-full transition-all"
                      style={{
                        left: chatOn ? '17px' : '2px',
                        background: 'var(--color-surface, #ffffff)',
                      }}
                    />
                  </button>
                </div>
                {missingSecrets && (
                  <div className="px-2 py-1 font-mono text-[8px]" style={{ color: 'var(--color-warning)' }}>
                    Missing bot token. Add it in API Keys (service: adapter:{adapter.type}, name: botToken).
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export default function SystemDefaults() {
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [defaultsByKey, setDefaultsByKey] = useState<Record<string, DefaultItem>>({});
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [permissionDraft, setPermissionDraft] = useState<string[]>([]);

  const loadDefaults = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<DefaultsResponse>(Api.Wallet, '/defaults');
      const flat = Object.values(res.defaults || {}).flat();
      const keyed: Record<string, DefaultItem> = {};
      for (const item of flat) keyed[item.key] = item;

      setDefaultsByKey(keyed);

      const nextDraftValues: Record<string, string> = {};
      for (const key of EDITABLE_KEYS) {
        if (key === 'permissions.default') continue;
        nextDraftValues[key] = formatInputValue(keyed[key]?.value);
      }
      setDraftValues(nextDraftValues);

      const permissionsValue = keyed['permissions.default']?.value;
      setPermissionDraft(Array.isArray(permissionsValue) ? permissionsValue.filter((p): p is string => typeof p === 'string') : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load defaults');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadDefaults(); }, [loadDefaults]);

  const rows = useMemo(() => EDITABLE_KEYS.map((key) => defaultsByKey[key]).filter(Boolean), [defaultsByKey]);

  const onSaveNumber = async (key: string) => {
    const raw = draftValues[key];
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
      setError(`${key} must be a number`);
      return;
    }

    setSavingKey(key);
    setError(null);
    setSaveMessage(null);
    try {
      await api.patch(Api.Wallet, `/defaults/${encodeURIComponent(key)}`, { value: parsed });
      setSaveMessage(`Saved ${key}`);
      await loadDefaults();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to save ${key}`);
    } finally {
      setSavingKey(null);
    }
  };

  const onSavePermissions = async () => {
    const key = 'permissions.default';
    setSavingKey(key);
    setError(null);
    setSaveMessage(null);
    try {
      await api.patch(Api.Wallet, `/defaults/${encodeURIComponent(key)}`, { value: permissionDraft });
      setSaveMessage('Saved permissions.default');
      await loadDefaults();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save permissions.default');
    } finally {
      setSavingKey(null);
    }
  };

  const onReset = async (key: string) => {
    setSavingKey(key);
    setError(null);
    setSaveMessage(null);
    try {
      await api.post(Api.Wallet, '/defaults/reset', { key });
      setSaveMessage(`Reset ${key}`);
      await loadDefaults();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to reset ${key}`);
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) {
    return (
      <div className="py-8 flex items-center justify-center">
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
      </div>
    );
  }

  return (
    <div className="space-y-3 p-2">
      <div>
        <div className="font-mono text-[10px] tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
          SYSTEM DEFAULTS
        </div>
        <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted)' }}>
          Edit baseline limits and permissions for new agent actions.
        </div>
      </div>

      {error && (
        <div className="p-2 font-mono text-[9px]" style={{ border: '1px solid var(--color-warning)', color: 'var(--color-warning)', background: 'var(--color-surface)' }}>
          {error}
        </div>
      )}
      {saveMessage && (
        <div className="p-2 font-mono text-[9px]" style={{ border: '1px solid var(--color-success)', color: 'var(--color-success)', background: 'var(--color-surface)' }}>
          {saveMessage}
        </div>
      )}

      {/* AI Engine section — above financial limits */}
      <AiEngineSection />

      {rows.filter((row) => row.key !== 'permissions.default').map((row) => (
        <div key={row.key} className="p-2 space-y-2" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
          <div>
            <div className="font-mono text-[10px]" style={{ color: 'var(--color-text)' }}>{row.label}</div>
            <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-muted)' }}>{row.description || row.key}</div>
          </div>
          <div className="flex items-end gap-2">
            <TextInput
              label={row.key}
              compact
              value={draftValues[row.key] ?? ''}
              onChange={(e) => setDraftValues((prev) => ({ ...prev, [row.key]: e.target.value }))}
              rightElement={
                SUFFIX_BY_KEY[row.key as keyof typeof SUFFIX_BY_KEY]
                  ? <span className="font-mono text-[8px] text-[var(--color-text-muted)]">{SUFFIX_BY_KEY[row.key as keyof typeof SUFFIX_BY_KEY]}</span>
                  : undefined
              }
            />
            <Button size="sm" onClick={() => void onSaveNumber(row.key)} loading={savingKey === row.key} icon={<Save size={11} />}>
              SAVE
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void onReset(row.key)} disabled={savingKey === row.key} icon={<RotateCcw size={11} />}>
              RESET
            </Button>
          </div>
        </div>
      ))}

      {defaultsByKey['permissions.default'] && (
        <div className="p-2 space-y-2" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
          <div>
            <div className="font-mono text-[10px]" style={{ color: 'var(--color-text)' }}>
              {defaultsByKey['permissions.default'].label}
            </div>
            <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-muted)' }}>
              {defaultsByKey['permissions.default'].description || 'permissions.default'}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {KNOWN_PERMISSIONS.map((perm) => {
              const checked = permissionDraft.includes(perm);
              return (
                <label key={perm} className="flex items-center gap-2 cursor-pointer font-mono text-[9px]" style={{ color: 'var(--color-text)' }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      setPermissionDraft((prev) => {
                        if (e.target.checked) return Array.from(new Set([...prev, perm]));
                        return prev.filter((p) => p !== perm);
                      });
                    }}
                  />
                  {perm}
                </label>
              );
            })}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void onSavePermissions()} loading={savingKey === 'permissions.default'} icon={<Save size={11} />}>
              SAVE
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void onReset('permissions.default')} disabled={savingKey === 'permissions.default'} icon={<RotateCcw size={11} />}>
              RESET
            </Button>
          </div>
        </div>
      )}

      {/* Adapter Chat toggles */}
      <AdapterChatSection />
    </div>
  );
}
