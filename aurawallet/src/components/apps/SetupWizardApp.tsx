'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Check, Loader2, ChevronDown, ChevronRight, Bot, Globe, MessageSquare, ExternalLink, Trash2, X, KeyRound, FlaskConical } from 'lucide-react';
import { Button, TextInput } from '@/components/design-system';
import { api, Api } from '@/lib/api';

interface ProviderInfo {
  mode: string;
  label: string;
  available: boolean;
  reason: string;
  models: string[];
}

interface AiStatusResponse {
  activeProvider: string;
  defaultModel: string;
  providers: ProviderInfo[];
}

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

/** Placeholder hints for API key inputs */
const KEY_PLACEHOLDER: Record<string, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
};

/** CLI provider instructions */
const CLI_INSTRUCTIONS: Record<string, string> = {
  'claude-cli': 'Make sure the `claude` CLI is installed and you\'re logged in (`claude login`).',
  'codex-cli': 'Make sure the `codex` CLI is installed and you\'re authenticated.',
};

interface SetupStatus {
  hasWallet: boolean;
  unlocked: boolean;
  address: string | null;
  apiKeys: { alchemy: boolean; anthropic: boolean };
  adapters: { telegram: boolean; webhook: boolean };
}

interface SetupWizardAppProps {
  config?: Record<string, unknown>;
}

function StepItem({ number, title, subtitle, icon, done, expanded, onToggle, children, doneContent }: {
  number: number;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  done: boolean;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  doneContent?: React.ReactNode;
}) {
  return (
    <div style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-3 text-left"
      >
        <div className="w-6 h-6 flex items-center justify-center flex-shrink-0" style={{
          background: done ? 'var(--color-success)' : 'var(--color-background-alt)',
          border: done ? 'none' : '1px solid var(--color-border)',
        }}>
          {done ? (
            <Check size={12} style={{ color: 'white' }} />
          ) : (
            <span className="font-mono text-[10px] font-bold" style={{ color: 'var(--color-text-muted)' }}>{number}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span style={{ color: done ? 'var(--color-success)' : 'var(--color-text)' }}>{icon}</span>
            <span className="font-mono text-[11px] font-bold" style={{ color: done ? 'var(--color-success)' : 'var(--color-text)' }}>
              {title}
            </span>
          </div>
          <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted)' }}>{subtitle}</div>
        </div>
        {expanded ? <ChevronDown size={14} style={{ color: 'var(--color-text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--color-text-muted)' }} />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
          {done ? doneContent : children}
        </div>
      )}
    </div>
  );
}

const SetupWizardApp: React.FC<SetupWizardAppProps> = () => {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Step 1: AI Provider
  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState<string>('claude-cli');
  const [providerKeyInput, setProviderKeyInput] = useState('');
  const [providerKeyValidating, setProviderKeyValidating] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [providerTesting, setProviderTesting] = useState(false);
  const [providerTestResult, setProviderTestResult] = useState<'success' | 'fail' | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);

  // Step 1 (continued): Permission Tier
  const [agentTier, setAgentTier] = useState<string>('admin');
  const [agentTierSaving, setAgentTierSaving] = useState(false);

  // Step 2: Alchemy key
  const [alchemyKey, setAlchemyKey] = useState('');
  const [alchemyValidating, setAlchemyValidating] = useState(false);
  const [alchemyError, setAlchemyError] = useState('');

  // Step 3: Telegram
  const [botToken, setBotToken] = useState('');
  const [botUsername, setBotUsername] = useState('');
  const [chatId, setChatId] = useState('');
  const [chatEnabled, setChatEnabled] = useState(true);
  const [telegramStep, setTelegramStep] = useState<'token' | 'detecting' | 'chatId' | 'testing' | 'done'>('token');
  const [telegramValidating, setTelegramValidating] = useState(false);
  const [telegramError, setTelegramError] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [, setSetupToken] = useState('');
  const [detectedName, setDetectedName] = useState('');
  const detectAbortRef = useRef<AbortController | null>(null);

  // Editing state — when set, forces the form to show instead of doneContent
  const [editingStep, setEditingStep] = useState<number | null>(null);

  // Done-state test for AI provider
  const [doneTestLoading, setDoneTestLoading] = useState(false);
  const [doneTestResult, setDoneTestResult] = useState<'success' | 'fail' | null>(null);

  // Removal state
  const [removingAlchemy, setRemovingAlchemy] = useState(false);
  const [removingTelegram, setRemovingTelegram] = useState(false);

  // Step 1 two-path state
  const [step1Tab, setStep1Tab] = useState<'provider' | 'agent'>('provider');
  const [agentPairAcknowledged, setAgentPairAcknowledged] = useState(false);

  /** Fetch AI status from /ai/status */
  const fetchAiStatus = useCallback(async () => {
    try {
      const res = await api.get<AiStatusResponse>(Api.Wallet, '/ai/status');
      setAiStatus(res);
      setSelectedProvider(res.activeProvider);
      return res;
    } catch {
      // AI status fetch failed
      return null;
    } finally {
      setAiLoading(false);
    }
  }, []);

  /** Check if AI provider step is complete: activeProvider is set AND available */
  const isAiStepDone = useCallback((ai: AiStatusResponse | null): boolean => {
    if (!ai) return false;
    const active = ai.providers.find(p => p.mode === ai.activeProvider);
    return !!active?.available;
  }, []);

  /** Fetch only setup status (wallet, apiKeys, adapters) — no /ai/status call */
  const fetchSetupStatus = useCallback(async () => {
    try {
      const data = await api.get<SetupStatus>(Api.Wallet, '/setup');
      setStatus(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  /** Auto-expand the first incomplete step */
  const autoExpand = useCallback((ai: AiStatusResponse | null, setup: SetupStatus | null, agentPaired?: boolean) => {
    const aiDone = isAiStepDone(ai);
    const step1Done = aiDone || (agentPaired ?? agentPairAcknowledged);
    if (!step1Done) setExpandedStep(1);
    else if (!setup?.apiKeys.alchemy) setExpandedStep(2);
    else if (!setup?.adapters.telegram) setExpandedStep(3);
    else setExpandedStep(null);
  }, [isAiStepDone, agentPairAcknowledged]);

  /** Initial load — fetch both endpoints + agent tier + localStorage */
  useEffect(() => {
    (async () => {
      try {
        const [setup, ai] = await Promise.all([
          fetchSetupStatus(),
          fetchAiStatus(),
          // Fetch agent tier
          api.get<Record<string, Array<{ key: string; value: unknown }>>>(Api.Wallet, '/defaults').then(grouped => {
            const permsGroup = grouped.permissions || [];
            const tierRow = permsGroup.find((r: { key: string }) => r.key === 'permissions.agent_tier');
            if (tierRow) setAgentTier(tierRow.value as string);
          }).catch(() => { /* use default */ }),
        ]);
        // Read agentPairAcknowledged from localStorage
        const addr = setup?.address || 'unknown';
        const paired = localStorage.getItem(`agentPaired:${addr}`) === 'true';
        setAgentPairAcknowledged(paired);
        if (paired) setStep1Tab('agent');
        autoExpand(ai, setup, paired);
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchSetupStatus, fetchAiStatus, autoExpand]);

  // Handle provider radio change
  const handleProviderChange = (mode: string) => {
    setSelectedProvider(mode);
    setProviderKeyInput('');
    setProviderError('');
    setProviderTestResult(null);
  };

  // Handle permission tier change
  const handleTierChange = async (tier: string) => {
    setAgentTier(tier);
    setAgentTierSaving(true);
    try {
      await api.patch(Api.Wallet, `/defaults/${encodeURIComponent('permissions.agent_tier')}`, { value: tier });
    } catch { setAgentTier(tier === 'admin' ? 'restricted' : 'admin'); }
    finally { setAgentTierSaving(false); }
  };

  // Validate + save API key for current provider, then save provider selection
  const handleProviderKeySave = async () => {
    const keyService = PROVIDER_KEY_SERVICE[selectedProvider];
    if (!keyService) return;
    setProviderError('');
    setProviderKeyValidating(true);
    try {
      const validation = await api.post<{ valid: boolean; error?: string }>(Api.Wallet, '/apikeys/validate', { service: keyService, key: providerKeyInput.trim() });
      if (!validation.valid) {
        setProviderError(validation.error || 'Invalid key');
        return;
      }
      await api.post(Api.Wallet, '/apikeys', { service: keyService, name: 'default', key: providerKeyInput.trim() });
      setProviderKeyInput('');
      // Save the provider selection
      await api.patch(Api.Wallet, `/defaults/${encodeURIComponent('ai.provider')}`, { value: selectedProvider });
      setEditingStep(null);
      const ai = await fetchAiStatus();
      autoExpand(ai, status);
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : 'Failed to validate');
    } finally {
      setProviderKeyValidating(false);
    }
  };

  // Test a CLI provider by re-fetching /ai/status
  const handleProviderTest = async () => {
    setProviderError('');
    setProviderTesting(true);
    setProviderTestResult(null);
    try {
      const res = await api.get<AiStatusResponse>(Api.Wallet, '/ai/status');
      setAiStatus(res);
      const provider = res.providers.find(p => p.mode === selectedProvider);
      if (provider?.available) {
        setProviderTestResult('success');
        // Save the provider selection
        setProviderSaving(true);
        await api.patch(Api.Wallet, `/defaults/${encodeURIComponent('ai.provider')}`, { value: selectedProvider });
        setEditingStep(null);
        autoExpand(res, status);
        setProviderSaving(false);
      } else {
        setProviderTestResult('fail');
        setProviderError(provider?.reason || 'Provider not available');
      }
    } catch (err) {
      setProviderTestResult('fail');
      setProviderError(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setProviderTesting(false);
    }
  };

  // Validate + save Alchemy key
  const handleAlchemySave = async () => {
    setAlchemyError('');
    setAlchemyValidating(true);
    try {
      const validation = await api.post<{ valid: boolean; error?: string }>(Api.Wallet, '/apikeys/validate', { service: 'alchemy', key: alchemyKey });
      if (!validation.valid) {
        setAlchemyError(validation.error || 'Invalid key');
        return;
      }
      await api.post(Api.Wallet, '/apikeys', { service: 'alchemy', name: 'default', key: alchemyKey });
      setAlchemyKey('');
      setEditingStep(null);
      const setup = await fetchSetupStatus();
      autoExpand(aiStatus, setup);
    } catch (err) {
      setAlchemyError(err instanceof Error ? err.message : 'Failed to validate');
    } finally {
      setAlchemyValidating(false);
    }
  };

  // Telegram flow: validate bot token, then start auto-detection
  const handleTelegramValidate = async () => {
    setTelegramError('');
    setTelegramValidating(true);
    try {
      // Validate the token
      const validation = await api.post<{ valid: boolean; error?: string; info?: { botUsername: string } }>(Api.Wallet, '/apikeys/validate', { service: 'adapter:telegram', key: botToken });
      if (!validation.valid) {
        setTelegramError(validation.error || 'Invalid bot token');
        return;
      }
      setBotUsername(validation.info?.botUsername || '');

      // Get deep link for auto-detection
      const linkResult = await api.post<{ success: boolean; link: string; setupToken: string; botUsername: string; error?: string }>(Api.Wallet, '/adapters/telegram/setup-link', { botToken });
      if (!linkResult.success) {
        setTelegramError(linkResult.error || 'Failed to generate setup link');
        setTelegramStep('chatId');
        return;
      }

      setDeepLink(linkResult.link);
      setSetupToken(linkResult.setupToken);
      setBotUsername(linkResult.botUsername);
      setTelegramStep('detecting');

      // Start polling for chat ID detection (up to 2 attempts ~ 50s)
      startDetection(linkResult.setupToken);
    } catch (err) {
      setTelegramError(err instanceof Error ? err.message : 'Failed to validate');
    } finally {
      setTelegramValidating(false);
    }
  };

  // Poll detect-chat endpoint
  const startDetection = async (token: string) => {
    const abort = new AbortController();
    detectAbortRef.current = abort;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (abort.signal.aborted) return;
      try {
        const result = await api.post<{ chatId: string | null; firstName?: string; username?: string; verified?: boolean; timeout?: boolean }>(Api.Wallet, '/adapters/telegram/detect-chat', { setupToken: token });
        if (abort.signal.aborted) return;

        if (result.chatId) {
          setChatId(result.chatId);
          const name = result.username ? `@${result.username}` : result.firstName || '';
          setDetectedName(name);
          // Auto-proceed: save bot token, adapter config, restart, test, and finish
          setTelegramStep('testing');
          try {
            await api.post(Api.Wallet, '/apikeys', { service: 'adapter:telegram', name: 'botToken', key: botToken });
            await api.post(Api.Wallet, '/adapters', {
              type: 'telegram',
              enabled: true,
              config: { chatId: result.chatId },
              chat: { enabled: true },
            });
            await api.post(Api.Wallet, '/adapters/restart');
            try {
              await api.post(Api.Wallet, '/adapters/test', { type: 'telegram' });
            } catch { /* non-critical */ }
            setTelegramStep('done');
            setBotToken('');
            setEditingStep(null);
            const setup = await fetchSetupStatus();
            autoExpand(aiStatus, setup);
          } catch {
            // Fall back to manual chatId step on error
            setTelegramStep('chatId');
          }
          return;
        }
        // timeout — try again
      } catch {
        if (abort.signal.aborted) return;
        // Fall through to manual
        break;
      }
    }

    // Timed out — fall back to manual entry
    if (!abort.signal.aborted) {
      setTelegramStep('chatId');
      setTelegramError('Auto-detection timed out. Enter your chat ID manually.');
    }
  };

  // Clean up detection polling on unmount
  useEffect(() => {
    return () => {
      detectAbortRef.current?.abort();
    };
  }, []);

  // Telegram flow: save config + restart + test
  const handleTelegramActivate = async () => {
    setTelegramError('');
    setTelegramValidating(true);
    setTelegramStep('testing');
    try {
      // Save bot token
      await api.post(Api.Wallet, '/apikeys', { service: 'adapter:telegram', name: 'botToken', key: botToken });
      // Save adapter config (include chat opt-in)
      await api.post(Api.Wallet, '/adapters', {
        type: 'telegram',
        enabled: true,
        config: { chatId },
        ...(chatEnabled ? { chat: { enabled: true } } : {}),
      });
      // Restart adapters
      await api.post(Api.Wallet, '/adapters/restart');
      // Test
      const testResult = await api.post<{ success: boolean; error?: string }>(Api.Wallet, '/adapters/test', { type: 'telegram' });
      if (!testResult.success) {
        setTelegramError(testResult.error || 'Test message failed');
        setTelegramStep('chatId');
        return;
      }
      setTelegramStep('done');
      setBotToken('');
      setChatId('');
      setEditingStep(null);
      const setup = await fetchSetupStatus();
      autoExpand(aiStatus, setup);
    } catch (err) {
      setTelegramError(err instanceof Error ? err.message : 'Activation failed');
      setTelegramStep('chatId');
    } finally {
      setTelegramValidating(false);
    }
  };

  // Remove an API key by service name
  const removeApiKey = async (service: string) => {
    const { apiKeys } = await api.get<{ apiKeys: { id: string; service: string }[] }>(Api.Wallet, '/apikeys');
    const key = apiKeys.find(k => k.service === service);
    if (key) {
      await api.delete(Api.Wallet, `/apikeys/${key.id}`);
    }
  };

  const handleRemoveProvider = () => {
    // Just clear local state and show the form — no API calls needed.
    // The old provider is only replaced when the user saves a new one.
    setProviderKeyInput('');
    setProviderError('');
    setProviderTestResult(null);
    setDoneTestResult(null);
    setEditingStep(1);
  };

  const handleRemoveAlchemy = async () => {
    setRemovingAlchemy(true);
    try {
      await removeApiKey('alchemy');
      setEditingStep(2);
      const setup = await fetchSetupStatus();
      autoExpand(aiStatus, setup);
    } finally {
      setRemovingAlchemy(false);
    }
  };

  const handleRemoveTelegram = async () => {
    setRemovingTelegram(true);
    try {
      // Abort any in-flight detection
      detectAbortRef.current?.abort();
      // Delete the adapter
      await api.delete(Api.Wallet, '/adapters/telegram');
      // Delete the bot token API key
      await removeApiKey('adapter:telegram');
      // Restart adapters
      await api.post(Api.Wallet, '/adapters/restart');
      // Clear all telegram state
      setBotToken('');
      setBotUsername('');
      setChatId('');
      setChatEnabled(false);
      setDeepLink('');
      setSetupToken('');
      setDetectedName('');
      setTelegramStep('token');
      setTelegramError('');
      setEditingStep(3);
      const setup = await fetchSetupStatus();
      autoExpand(aiStatus, setup);
    } finally {
      setRemovingTelegram(false);
    }
  };

  const handleDismiss = () => {
    const addr = status?.address || 'unknown';
    localStorage.setItem(`setupWizardDismissed:${addr}`, 'true');
    setDismissed(true);
  };

  if (dismissed) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="font-mono text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
          Dismissed. Close this app with the X button above.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
      </div>
    );
  }

  const aiStepDone = isAiStepDone(aiStatus);
  const step1Done = aiStepDone || agentPairAcknowledged;
  const allDone = step1Done && status?.apiKeys.alchemy && status?.adapters.telegram;

  // Derive selected provider info for rendering
  const selectedProviderInfo = aiStatus?.providers.find(p => p.mode === selectedProvider);
  const activeProviderInfo = aiStatus?.providers.find(p => p.mode === aiStatus.activeProvider);
  const keyService = PROVIDER_KEY_SERVICE[selectedProvider];
  const isCliProvider = keyService === null;

  return (
    <div className="space-y-1 p-1">
      {/* Header */}
      <div className="text-center mb-3">
        <div className="font-mono text-[10px] tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
          {allDone ? 'SETUP COMPLETE' : 'FINISH YOUR SETUP'}
        </div>
      </div>

      {allDone && (
        <div className="text-center py-4 space-y-3">
          <div className="w-10 h-10 mx-auto flex items-center justify-center" style={{ background: 'var(--color-success)', color: 'white' }}>
            <Check size={20} />
          </div>
          <div className="font-mono text-xs" style={{ color: 'var(--color-text)' }}>All set! Your wallet is fully configured.</div>
        </div>
      )}

      {/* Step 1: AI Agent */}
      <StepItem
        number={1}
        title="AI Agent"
        subtitle="Connect an AI provider or pair with an agent"
        icon={<Bot size={14} />}
        done={(aiStepDone || agentPairAcknowledged) && editingStep !== 1}
        expanded={expandedStep === 1}
        onToggle={() => setExpandedStep(expandedStep === 1 ? null : 1)}
        doneContent={
          <div className="space-y-2 pt-2">
            {aiStepDone && !agentPairAcknowledged && (
              <>
                <div className="flex items-center gap-2 p-2" style={{ background: 'var(--color-background-alt)', border: '1px solid var(--color-border)' }}>
                  <Check size={12} style={{ color: 'var(--color-success)' }} />
                  <span className="font-mono text-[10px]" style={{ color: 'var(--color-success)' }}>
                    {activeProviderInfo?.label || aiStatus?.activeProvider || 'AI provider'} configured
                  </span>
                </div>
                {doneTestResult === 'success' && (
                  <div className="flex items-center gap-2 p-1.5" style={{ border: '1px solid var(--color-success)', color: 'var(--color-success)' }}>
                    <Check size={10} />
                    <span className="font-mono text-[9px]">Provider available</span>
                  </div>
                )}
                {doneTestResult === 'fail' && (
                  <div className="font-mono text-[9px]" style={{ color: 'var(--color-warning)' }}>Provider not available</div>
                )}
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={async () => {
                    setDoneTestLoading(true);
                    setDoneTestResult(null);
                    try {
                      const res = await api.get<AiStatusResponse>(Api.Wallet, '/ai/status');
                      setAiStatus(res);
                      const provider = res.providers.find(p => p.mode === res.activeProvider);
                      setDoneTestResult(provider?.available ? 'success' : 'fail');
                    } catch {
                      setDoneTestResult('fail');
                    } finally {
                      setDoneTestLoading(false);
                    }
                  }} disabled={doneTestLoading} loading={doneTestLoading} icon={<FlaskConical size={10} />}>
                    TEST
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRemoveProvider} icon={<Trash2 size={10} />}>
                    CHANGE
                  </Button>
                </div>
              </>
            )}
            {agentPairAcknowledged && (
              <>
                <div className="flex items-center gap-2 p-2" style={{ background: 'var(--color-background-alt)', border: '1px solid var(--color-border)' }}>
                  <Check size={12} style={{ color: 'var(--color-success)' }} />
                  <span className="font-mono text-[10px]" style={{ color: 'var(--color-success)' }}>
                    Agent paired externally
                  </span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => {
                  const addr = status?.address || 'unknown';
                  localStorage.removeItem(`agentPaired:${addr}`);
                  setAgentPairAcknowledged(false);
                  setEditingStep(1);
                }} icon={<Trash2 size={10} />}>
                  CHANGE
                </Button>
              </>
            )}
          </div>
        }
      >
        <div className="space-y-3 pt-2">
          {/* Tab selector */}
          <div className="flex gap-2">
            <button
              onClick={() => setStep1Tab('provider')}
              className="flex-1 p-1.5 font-mono text-[9px] text-left"
              style={{
                border: step1Tab === 'provider' ? '1px solid var(--color-accent, #ccff00)' : '1px solid var(--color-border)',
                background: step1Tab === 'provider' ? 'var(--color-background-alt)' : 'transparent',
                color: step1Tab === 'provider' ? 'var(--color-text)' : 'var(--color-text-muted)',
              }}
            >
              <div className="font-bold">AI Provider</div>
              <div className="text-[8px]" style={{ color: 'var(--color-text-muted)' }}>Claude Max, API keys</div>
            </button>
            <button
              onClick={() => setStep1Tab('agent')}
              className="flex-1 p-1.5 font-mono text-[9px] text-left"
              style={{
                border: step1Tab === 'agent' ? '1px solid var(--color-accent, #ccff00)' : '1px solid var(--color-border)',
                background: step1Tab === 'agent' ? 'var(--color-background-alt)' : 'transparent',
                color: step1Tab === 'agent' ? 'var(--color-text)' : 'var(--color-text-muted)',
              }}
            >
              <div className="font-bold">Pair with Agent</div>
              <div className="text-[8px]" style={{ color: 'var(--color-text-muted)' }}>MCP, skill, CLI, API</div>
            </button>
          </div>

          {/* Provider tab */}
          {step1Tab === 'provider' && (
            <>
              {aiLoading ? (
                <div className="py-3 flex items-center justify-center">
                  <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
                </div>
              ) : (
                <>
                  {/* Provider radio buttons */}
                  <div className="space-y-1">
                    <div className="font-mono text-[9px] font-bold" style={{ color: 'var(--color-text)' }}>Provider</div>
                    {aiStatus?.providers.map((p) => (
                      <label
                        key={p.mode}
                        className="flex items-center gap-2 cursor-pointer py-1 px-1.5"
                        style={{
                          border: selectedProvider === p.mode ? '1px solid var(--color-accent, #ccff00)' : '1px solid transparent',
                          background: selectedProvider === p.mode ? 'var(--color-background-alt, #f4f4f5)' : 'transparent',
                        }}
                      >
                        <input
                          type="radio"
                          name="setup-ai-provider"
                          value={p.mode}
                          checked={selectedProvider === p.mode}
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
                        {!p.available && (
                          <span className="font-mono text-[8px]" style={{ color: 'var(--color-text-muted)' }}>
                            {p.reason}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>

                  {/* CLI provider: instructions + test button */}
                  {isCliProvider && selectedProviderInfo && (
                    <div className="space-y-2">
                      <div className="p-1.5 font-mono text-[8px]" style={{ background: 'var(--color-background-alt)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
                        {CLI_INSTRUCTIONS[selectedProvider] || `Make sure the CLI is installed and authenticated.`}
                      </div>
                      {providerTestResult === 'success' && (
                        <div className="flex items-center gap-2 p-1.5" style={{ border: '1px solid var(--color-success)', color: 'var(--color-success)' }}>
                          <Check size={10} />
                          <span className="font-mono text-[9px]">Available! Provider saved.</span>
                        </div>
                      )}
                      <Button size="sm" onClick={handleProviderTest} disabled={providerTesting || providerSaving} loading={providerTesting || providerSaving} icon={<FlaskConical size={10} />}>
                        TEST
                      </Button>
                    </div>
                  )}

                  {/* API provider: key input form */}
                  {!isCliProvider && keyService && (
                    <div className="space-y-2">
                      <TextInput
                        label={`${KEY_SERVICE_LABEL[keyService] || keyService} API Key`}
                        type="password"
                        value={providerKeyInput}
                        onChange={e => { setProviderKeyInput(e.target.value); setProviderError(''); }}
                        placeholder={KEY_PLACEHOLDER[keyService] || 'Paste your API key...'}
                        compact
                        rightElement={<KeyRound size={10} style={{ color: 'var(--color-text-muted)' }} />}
                      />
                      <Button size="sm" onClick={handleProviderKeySave} disabled={providerKeyValidating || !providerKeyInput.trim()} loading={providerKeyValidating}>
                        VALIDATE & SAVE
                      </Button>
                    </div>
                  )}

                  {/* Error display */}
                  {providerError && (
                    <div className="font-mono text-[9px]" style={{ color: 'var(--color-warning)' }}>{providerError}</div>
                  )}

                  {/* Permission Tier Toggle */}
                  <div className="space-y-1 pt-2 mt-2" style={{ borderTop: '1px solid var(--color-border)' }}>
                    <div className="font-mono text-[9px] font-bold" style={{ color: 'var(--color-text)' }}>Permission Level</div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleTierChange('admin')}
                        disabled={agentTierSaving}
                        className="flex-1 p-1.5 font-mono text-[9px] text-left"
                        style={{
                          border: agentTier === 'admin' ? '1px solid var(--color-accent, #ccff00)' : '1px solid var(--color-border)',
                          background: agentTier === 'admin' ? 'var(--color-background-alt)' : 'transparent',
                          color: agentTier === 'admin' ? 'var(--color-text)' : 'var(--color-text-muted)',
                          opacity: agentTierSaving ? 0.5 : 1,
                        }}
                      >
                        <div className="font-bold">Full Admin</div>
                        <div className="text-[8px]" style={{ color: 'var(--color-text-muted)' }}>Recommended</div>
                      </button>
                      <button
                        onClick={() => handleTierChange('restricted')}
                        disabled={agentTierSaving}
                        className="flex-1 p-1.5 font-mono text-[9px] text-left"
                        style={{
                          border: agentTier === 'restricted' ? '1px solid var(--color-accent, #ccff00)' : '1px solid var(--color-border)',
                          background: agentTier === 'restricted' ? 'var(--color-background-alt)' : 'transparent',
                          color: agentTier === 'restricted' ? 'var(--color-text)' : 'var(--color-text-muted)',
                          opacity: agentTierSaving ? 0.5 : 1,
                        }}
                      >
                        <div className="font-bold">Restricted</div>
                        <div className="text-[8px]" style={{ color: 'var(--color-text-muted)' }}>Approval required</div>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* Agent tab */}
          {step1Tab === 'agent' && (
            <div className="space-y-2">
              <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted)' }}>
                Choose the path that matches your setup:
              </div>
              {[
                { label: 'Agent Skill', desc: 'Claude Code, Cursor, VS Code, Windsurf', cmd: 'npx skills add Aura-Industry/aurawallet', note: 'Then ask: "Set up my wallet"' },
                { label: 'MCP Server', desc: 'Claude Desktop or any MCP client', cmd: 'npx aurawallet mcp --install', note: 'Auto-configures your IDE' },
                { label: 'Headless CLI', desc: 'Local bots, CI/CD, containers', cmd: 'npx tsx src/server/cli/index.ts', note: 'Approve agent requests in terminal' },
                { label: 'Direct API', desc: 'Any language or platform', cmd: 'curl http://localhost:4242/health', note: 'POST /auth to bootstrap a token' },
              ].map((path) => (
                <div key={path.label} className="p-2" style={{ background: 'var(--color-background-alt)', border: '1px solid var(--color-border)' }}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] font-bold" style={{ color: 'var(--color-text)' }}>{path.label}</span>
                    <span className="font-mono text-[8px]" style={{ color: 'var(--color-text-muted)' }}>{path.desc}</span>
                  </div>
                  <div className="font-mono text-[9px] mt-1 px-1.5 py-1" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
                    {path.cmd}
                  </div>
                  <div className="font-mono text-[8px] mt-1" style={{ color: 'var(--color-text-faint, #9ca3af)' }}>{path.note}</div>
                </div>
              ))}
              <Button size="sm" onClick={() => {
                const addr = status?.address || 'unknown';
                localStorage.setItem(`agentPaired:${addr}`, 'true');
                setAgentPairAcknowledged(true);
                setEditingStep(null);
                autoExpand(aiStatus, status);
              }} className="w-full">
                I&apos;VE CONNECTED
              </Button>
            </div>
          )}
        </div>
      </StepItem>

      {/* Step 2: RPC Provider */}
      <StepItem
        number={2}
        title="RPC Provider"
        subtitle="Add Alchemy for reliable RPC"
        icon={<Globe size={14} />}
        done={!!status?.apiKeys.alchemy && editingStep !== 2}
        expanded={expandedStep === 2}
        onToggle={() => setExpandedStep(expandedStep === 2 ? null : 2)}
        doneContent={
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2 p-2" style={{ background: 'var(--color-background-alt)', border: '1px solid var(--color-border)' }}>
              <Check size={12} style={{ color: 'var(--color-success)' }} />
              <span className="font-mono text-[10px]" style={{ color: 'var(--color-success)' }}>Alchemy key configured</span>
            </div>
            <Button variant="ghost" size="sm" onClick={handleRemoveAlchemy} disabled={removingAlchemy} loading={removingAlchemy} icon={<Trash2 size={10} />}>
              REMOVE
            </Button>
          </div>
        }
      >
        <div className="space-y-2 pt-2">
          <TextInput label="ALCHEMY_KEY" type="password" value={alchemyKey} onChange={e => setAlchemyKey(e.target.value)} placeholder="Paste your Alchemy API key..." compact />
          {alchemyError && <div className="font-mono text-[9px]" style={{ color: 'var(--color-warning)' }}>{alchemyError}</div>}
          <Button size="sm" onClick={handleAlchemySave} disabled={alchemyValidating || !alchemyKey} loading={alchemyValidating}>
            VALIDATE & SAVE
          </Button>
        </div>
      </StepItem>

      {/* Step 3: Mobile Approvals */}
      <StepItem
        number={3}
        title="Mobile Approvals"
        subtitle="Approve agent actions via Telegram"
        icon={<MessageSquare size={14} />}
        done={!!status?.adapters.telegram && editingStep !== 3}
        expanded={expandedStep === 3}
        onToggle={() => setExpandedStep(expandedStep === 3 ? null : 3)}
        doneContent={
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2 p-2" style={{ background: 'var(--color-background-alt)', border: '1px solid var(--color-border)' }}>
              <Check size={12} style={{ color: 'var(--color-success)' }} />
              <span className="font-mono text-[10px]" style={{ color: 'var(--color-success)' }}>Telegram connected</span>
            </div>
            <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-muted)' }}>
              Agent chat is enabled by default. You can toggle it in System Defaults &rarr; Adapter Chat.
            </div>
            <Button variant="ghost" size="sm" onClick={handleRemoveTelegram} disabled={removingTelegram} loading={removingTelegram} icon={<Trash2 size={10} />}>
              REMOVE
            </Button>
          </div>
        }
      >
        <div className="space-y-2 pt-2">
          {telegramStep === 'token' && (
            <>
              <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-muted)' }}>
                Approve agent actions from your phone via Telegram. Optionally, chat with your AI agent directly.
              </div>
              <TextInput label="BOT_TOKEN" type="password" value={botToken} onChange={e => setBotToken(e.target.value)} placeholder="123456:ABC-DEF..." compact />
              <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-faint)' }}>
                Create a bot via @BotFather on Telegram
              </div>
              <Button size="sm" onClick={handleTelegramValidate} disabled={telegramValidating || !botToken} loading={telegramValidating}>
                VALIDATE BOT
              </Button>
            </>
          )}
          {telegramStep === 'detecting' && (
            <>
              {botUsername && (
                <div className="flex items-center gap-2 p-2" style={{ background: 'var(--color-background-alt)', border: '1px solid var(--color-border)' }}>
                  <Check size={12} style={{ color: 'var(--color-success)' }} />
                  <span className="font-mono text-[10px]" style={{ color: 'var(--color-text)' }}>@{botUsername}</span>
                </div>
              )}
              <Button variant="secondary" size="sm" icon={<ExternalLink size={10} />}
                onClick={() => window.open(deepLink, '_blank')}>
                Open @{botUsername} in Telegram
              </Button>
              <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-faint)' }}>
                Click the link above, then press Start in Telegram
              </div>
              <div className="flex items-center gap-2 py-2">
                <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-info)' }} />
                <span className="font-mono text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Waiting for you to press Start...</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => { detectAbortRef.current?.abort(); setTelegramStep('chatId'); }}>
                ENTER MANUALLY
              </Button>
            </>
          )}
          {telegramStep === 'chatId' && (
            <>
              {botUsername && (
                <div className="flex items-center gap-2 p-2" style={{ background: 'var(--color-background-alt)', border: '1px solid var(--color-border)' }}>
                  <Check size={12} style={{ color: 'var(--color-success)' }} />
                  <span className="font-mono text-[10px]" style={{ color: 'var(--color-text)' }}>@{botUsername}</span>
                </div>
              )}
              {detectedName && chatId && (
                <div className="flex items-center gap-2 p-2" style={{ background: 'var(--color-background-alt)', border: '1px solid var(--color-success)' }}>
                  <Check size={12} style={{ color: 'var(--color-success)' }} />
                  <span className="font-mono text-[10px]" style={{ color: 'var(--color-success)' }}>Detected: {detectedName} ({chatId})</span>
                </div>
              )}
              {!detectedName && (
                <>
                  <TextInput label="CHAT_ID" type="text" value={chatId} onChange={e => setChatId(e.target.value)} placeholder="Your Telegram chat ID..." compact />
                  <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-faint)' }}>
                    Send /start to your bot, then use @userinfobot to get your chat ID
                  </div>
                </>
              )}
              <label className="flex items-center gap-2 py-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={chatEnabled}
                  onChange={e => setChatEnabled(e.target.checked)}
                  className="accent-[var(--color-accent)]"
                />
                <span className="font-mono text-[10px]" style={{ color: 'var(--color-text)' }}>Enable agent chat</span>
              </label>
              <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-faint)' }}>
                Enable this to chat with your agent via Telegram. Your AI agent will respond to messages you send in this chat.
              </div>
              <Button size="sm" onClick={handleTelegramActivate} disabled={telegramValidating || !chatId} loading={telegramValidating}>
                ACTIVATE & TEST
              </Button>
            </>
          )}
          {telegramStep === 'testing' && (
            <div className="flex items-center gap-2 py-2">
              <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-info)' }} />
              <span className="font-mono text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Testing connection...</span>
            </div>
          )}
          {telegramStep === 'done' && (
            <div className="flex items-center gap-2 py-2">
              <Check size={14} style={{ color: 'var(--color-success)' }} />
              <span className="font-mono text-[10px]" style={{ color: 'var(--color-success)' }}>Telegram connected!</span>
            </div>
          )}
          {telegramError && <div className="font-mono text-[9px]" style={{ color: 'var(--color-warning)' }}>{telegramError}</div>}
        </div>
      </StepItem>

      {!allDone && (
        <div className="pt-3 flex justify-end">
          <Button variant="ghost" size="sm" onClick={handleDismiss}>
            SKIP FOR NOW
          </Button>
        </div>
      )}

      {allDone && (
        <div className="pt-3 flex justify-end">
          <Button variant="ghost" size="sm" onClick={handleDismiss}>
            DISMISS
          </Button>
        </div>
      )}
    </div>
  );
};

export { SetupWizardApp };
export default SetupWizardApp;
