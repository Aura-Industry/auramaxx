import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Bot, ChevronDown, ChevronUp, Database, KeyRound, Loader2, Plus, RotateCcw } from 'lucide-react';
import type { ColorMode, UiScale } from '@/hooks/useTheme';
import { useAuth } from '@/context/AuthContext';
import { api, Api } from '@/lib/api';
import { Button, ConfirmationModal, Drawer, ItemPicker, TextInput, Toggle, TyvekCollapsibleSection } from '@/components/design-system';

type LocalAgentMode = 'strict' | 'dev' | 'admin';
type ProjectScopeMode = 'auto' | 'strict' | 'off';

type ItemOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

type LocalPolicySettings = {
  profile: LocalAgentMode;
  profileVersion: 'v1';
  autoApprove: boolean;
  projectScopeMode: ProjectScopeMode;
};

type AdapterSummary = {
  type: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  chat?: { enabled?: boolean };
  hasSecrets?: boolean;
  secretKeys?: string[];
};

const TESTABLE_ADAPTER_TYPES = new Set(['telegram', 'webhook', 'whatsapp', 'discord']);
const REQUIRED_TEST_SECRETS: Record<string, string[]> = {
  telegram: ['botToken'],
  discord: ['botToken'],
};
const TELEGRAM_TOKEN_CONFIG_KEYS = ['botToken', 'token'] as const;
const DISCORD_CHANNEL_ID_KEYS = ['channelId', 'channel_id'] as const;
const ADAPTER_TYPES: Array<'telegram' | 'whatsapp' | 'discord'> = ['telegram', 'whatsapp', 'discord'];

function readStringByKeys(config: Record<string, unknown> | undefined, keys: readonly string[]): string | null {
  if (!config) return null;
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function hasTelegramTokenConfigured(adapter: AdapterSummary): boolean {
  const configuredSecretKeys = new Set(
    (adapter.secretKeys || [])
      .filter((key): key is string => typeof key === 'string')
      .map((key) => key.trim()),
  );

  if (configuredSecretKeys.has('botToken')) {
    return true;
  }

  if (adapter.hasSecrets) {
    return true;
  }

  return readStringByKeys(adapter.config, TELEGRAM_TOKEN_CONFIG_KEYS) !== null;
}

function getMissingTestSecrets(adapter: AdapterSummary): string[] {
  const normalizedType = adapter.type.trim().toLowerCase();
  if (normalizedType === 'telegram' && hasTelegramTokenConfigured(adapter)) {
    return [];
  }

  const required = REQUIRED_TEST_SECRETS[normalizedType] || [];
  const configured = new Set(
    (adapter.secretKeys || [])
      .filter((key): key is string => typeof key === 'string')
      .map((key) => key.trim()),
  );
  return required.filter((key) => !configured.has(key));
}

function createDefaultAdapter(type: 'telegram' | 'whatsapp' | 'discord'): AdapterSummary {
  if (type === 'whatsapp') {
    return {
      type,
      enabled: false,
      config: {
        allowFrom: ['*'],
        dmPolicy: 'open',
        groupPolicy: 'allowlist',
      },
      chat: { enabled: false },
      hasSecrets: false,
      secretKeys: [],
    };
  }

  if (type === 'discord') {
    return {
      type,
      enabled: false,
      config: {
        channelId: '',
      },
      chat: { enabled: false },
      hasSecrets: false,
      secretKeys: [],
    };
  }

  return {
    type,
    enabled: false,
    config: {},
    chat: { enabled: false },
    hasSecrets: false,
    secretKeys: [],
  };
}

function renderMessageWithLinks(message: string): ReactNode {
  const botPattern = /@([a-zA-Z0-9_]{3,}) \((https:\/\/t\.me\/[^\s),]+)\)/g;
  const botMatches = Array.from(message.matchAll(botPattern));
  if (botMatches.length > 0) {
    const chunks: ReactNode[] = [];
    let cursor = 0;

    for (const [index, match] of botMatches.entries()) {
      const username = match[1];
      const url = match[2];
      const start = match.index ?? 0;
      const full = match[0];

      if (start > cursor) {
        chunks.push(renderMessageWithLinks(message.slice(cursor, start)));
      }

      chunks.push(
        <span key={`bot-${username}-${start}-${index}`}>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-dotted underline-offset-2 hover:no-underline"
          >
            @{username}
          </a>
          {' ('}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-dotted underline-offset-2 hover:no-underline"
          >
            {url}
          </a>
          {')'}
        </span>,
      );

      cursor = start + full.length;
    }

    if (cursor < message.length) {
      chunks.push(renderMessageWithLinks(message.slice(cursor)));
    }

    return chunks;
  }

  const urlPattern = /https?:\/\/[^\s),]+/g;
  const matches = Array.from(message.matchAll(urlPattern));
  if (matches.length === 0) return message;

  const chunks: ReactNode[] = [];
  let cursor = 0;
  for (const [index, match] of matches.entries()) {
    const url = match[0];
    const start = match.index ?? 0;
    if (start > cursor) {
      chunks.push(message.slice(cursor, start));
    }
    chunks.push(
      <a
        key={`${url}-${start}-${index}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:no-underline"
      >
        {url}
      </a>,
    );
    cursor = start + url.length;
  }

  if (cursor < message.length) {
    chunks.push(message.slice(cursor));
  }

  return chunks;
}

interface AdaptersListResponse {
  success: boolean;
  adapters?: AdapterSummary[];
}

interface AdapterSecretValueResponse {
  success?: boolean;
  value?: string;
}

interface WhatsAppSetupQrResponse {
  success?: boolean;
  status?: 'idle' | 'waiting_qr' | 'qr_ready' | 'connected' | 'error';
  setupId?: string;
  qr?: string | null;
  error?: string;
  authDir?: string;
  expiresAt?: number;
}

type BackupSummary = {
  filename: string;
  timestamp: string;
  size: number;
  date: string;
};

interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  passwordChangeSuccess: string | null;
  agentThemeOpen: boolean;
  onToggleAgentTheme: () => void;
  colorMode: ColorMode;
  uiScale: UiScale;
  onColorModeChange: (value: ColorMode) => void;
  onUiScaleChange: (value: UiScale) => void;
  agentColorModeOptions: ReadonlyArray<ItemOption<ColorMode>>;
  agentUiScaleOptions: ReadonlyArray<ItemOption<UiScale>>;
  agentSettingsOpen: boolean;
  onToggleAgentSettings: () => void;
  policyLoadError: string | null;
  policyLoading: boolean;
  onRetryLoadPolicy: () => void;
  policyForm: LocalPolicySettings;
  onPolicyAutoApproveChange: (checked: boolean) => void;
  localProfileOptions: ReadonlyArray<ItemOption<LocalAgentMode>>;
  onPolicyProfileChange: (value: LocalAgentMode) => void;
  localProjectScopeOptions: ReadonlyArray<ItemOption<ProjectScopeMode>>;
  onPolicyProjectScopeModeChange: (value: ProjectScopeMode) => void;
  dangerConfirmOpen: boolean;
  onCancelDangerConfirm: () => void;
  onConfirmDangerousSave: () => void;
  policySaving: boolean;
  policySaveError: string | null;
  policySaveSuccess: string | null;
  canSavePolicy: boolean;
  onSavePolicy: () => void;
  securitySettingsOpen: boolean;
  onToggleSecuritySettings: () => void;
  passwordChangeError: string | null;
  onOpenPasswordModal: () => void;
  backupSectionOpen: boolean;
  onToggleBackupSection: () => void;
  creatingBackup: boolean;
  onCreateBackup: () => void;
  exportingDb: boolean;
  onExportDb: () => void;
  backupsLoading: boolean;
  backups: BackupSummary[];
  formatBackupDate: (timestamp: string) => string;
  formatSize: (bytes: number) => string;
  restoreConfirmOpen: string | null;
  onOpenRestoreConfirm: (filename: string, anchorEl: HTMLElement) => void;
  onCloseRestoreConfirm: () => void;
  onConfirmRestore: (filename: string) => void;
  restoringBackup: string | null;
  dangerZoneOpen: boolean;
  onToggleDangerZone: () => void;
  nukeError: string | null;
  onOpenNukeConfirm: () => void;
  nuking: boolean;
}

export function SettingsDrawer({
  isOpen,
  onClose,
  passwordChangeSuccess,
  agentThemeOpen,
  onToggleAgentTheme,
  colorMode,
  uiScale,
  onColorModeChange,
  onUiScaleChange,
  agentColorModeOptions,
  agentUiScaleOptions,
  agentSettingsOpen,
  onToggleAgentSettings,
  policyLoadError,
  policyLoading,
  onRetryLoadPolicy,
  policyForm,
  onPolicyAutoApproveChange,
  localProfileOptions,
  onPolicyProfileChange,
  localProjectScopeOptions,
  onPolicyProjectScopeModeChange,
  dangerConfirmOpen,
  onCancelDangerConfirm,
  onConfirmDangerousSave,
  policySaving,
  policySaveError,
  policySaveSuccess,
  canSavePolicy,
  onSavePolicy,
  securitySettingsOpen,
  onToggleSecuritySettings,
  passwordChangeError,
  onOpenPasswordModal,
  backupSectionOpen,
  onToggleBackupSection,
  creatingBackup,
  onCreateBackup,
  exportingDb,
  onExportDb,
  backupsLoading,
  backups,
  formatBackupDate,
  formatSize,
  restoreConfirmOpen,
  onOpenRestoreConfirm,
  onCloseRestoreConfirm,
  onConfirmRestore,
  restoringBackup,
  dangerZoneOpen,
  onToggleDangerZone,
  nukeError,
  onOpenNukeConfirm,
  nuking,
}: SettingsDrawerProps) {
  const { token } = useAuth();
  const [adaptersOpen, setAdaptersOpen] = useState(false);
  const [openClawAdapters, setOpenClawAdapters] = useState<AdapterSummary[]>([]);
  const [openClawLoading, setOpenClawLoading] = useState(false);
  const [openClawError, setOpenClawError] = useState<string | null>(null);
  const [openClawSuccess, setOpenClawSuccess] = useState<string | null>(null);
  const [openClawChannelUpdatingByType, setOpenClawChannelUpdatingByType] = useState<Record<string, boolean>>({});
  const [openClawTestingByType, setOpenClawTestingByType] = useState<Record<string, boolean>>({});
  const [openClawDeletingByType, setOpenClawDeletingByType] = useState<Record<string, boolean>>({});
  const [openClawTokenEditorOpenByType, setOpenClawTokenEditorOpenByType] = useState<Record<string, boolean>>({});
  const [openClawTokenDraftByType, setOpenClawTokenDraftByType] = useState<Record<string, string>>({});
  const [openClawDiscordChannelDraftByType, setOpenClawDiscordChannelDraftByType] = useState<Record<string, string>>({});
  const [openClawTokenSavingByType, setOpenClawTokenSavingByType] = useState<Record<string, boolean>>({});
  const [whatsAppSetupLoading, setWhatsAppSetupLoading] = useState(false);
  const [whatsAppSetupStatus, setWhatsAppSetupStatus] = useState<'idle' | 'waiting_qr' | 'qr_ready' | 'connected' | 'error'>('idle');
  const [whatsAppSetupQr, setWhatsAppSetupQr] = useState<string | null>(null);
  const [whatsAppSetupError, setWhatsAppSetupError] = useState<string | null>(null);

  const loadAdaptersSummary = useCallback(async () => {
    if (!token) {
      setOpenClawAdapters([]);
      setOpenClawError('Unlock agent first to manage adapters.');
      return;
    }

    setOpenClawLoading(true);
    setOpenClawError(null);
    try {
      const data = await api.get<AdaptersListResponse>(Api.Wallet, '/adapters');
      const incoming = Array.isArray(data.adapters) ? data.adapters : [];
      const byType = new Map<string, AdapterSummary>();
      for (const adapter of incoming) {
        const type = adapter.type.trim().toLowerCase();
        byType.set(type, adapter);
      }
      const next = ADAPTER_TYPES.map((type) => byType.get(type) || createDefaultAdapter(type));
      setOpenClawAdapters(next);
    } catch (err) {
      setOpenClawAdapters([]);
      setOpenClawError((err as Error).message || 'Failed to load adapters.');
    } finally {
      setOpenClawLoading(false);
    }
  }, [token]);

  const handleToggleAdapters = useCallback(() => {
    const next = !adaptersOpen;
    setAdaptersOpen(next);
    if (next) {
      void loadAdaptersSummary();
    }
  }, [adaptersOpen, loadAdaptersSummary]);

  const handleToggleAdapterChannel = useCallback(async (adapterType: string, enabled: boolean) => {
    const target = openClawAdapters.find((adapter) => adapter.type === adapterType);
    if (!target) return;
    const normalizedType = target.type.trim().toLowerCase() as 'telegram' | 'whatsapp' | 'discord';
    const fallback = createDefaultAdapter(normalizedType);
    const nextConfig = {
      ...(fallback.config || {}),
      ...(target.config || {}),
    };

    setOpenClawError(null);
    setOpenClawChannelUpdatingByType((prev) => ({ ...prev, [adapterType]: true }));
    try {
      await api.post(Api.Wallet, '/adapters', {
        type: target.type,
        enabled,
        config: nextConfig,
        chat: { enabled },
      });
      setOpenClawAdapters((prev) =>
        prev.map((adapter) => (
          adapter.type === adapterType
            ? { ...adapter, enabled, chat: { enabled } }
            : adapter
        )),
      );
    } catch (err) {
      setOpenClawError((err as Error).message || `Failed to update channel state for ${adapterType}.`);
    } finally {
      setOpenClawChannelUpdatingByType((prev) => ({ ...prev, [adapterType]: false }));
    }
  }, [openClawAdapters]);

  const handleTestAdapterChannel = useCallback(async (adapterType: string) => {
    const normalizedType = adapterType.trim().toLowerCase();
    const adapter = openClawAdapters.find((entry) => entry.type.trim().toLowerCase() === normalizedType);
    const missingSecrets = adapter ? getMissingTestSecrets(adapter) : [];

    if (!TESTABLE_ADAPTER_TYPES.has(normalizedType)) {
      setOpenClawError(`${adapterType} does not support test yet.`);
      return;
    }
    if (missingSecrets.length > 0) {
      setOpenClawError(`Cannot test ${adapterType}: missing ${missingSecrets.join(', ')}.`);
      return;
    }

    setOpenClawError(null);
    setOpenClawSuccess(null);
    setOpenClawTestingByType((prev) => ({ ...prev, [normalizedType]: true }));
    try {
      const result = await api.post<{ success?: boolean; error?: string; message?: string }>(Api.Wallet, '/adapters/test', {
        type: normalizedType,
      });
      if (result && result.success === false) {
        throw new Error(result.error || `Adapter test failed for ${adapterType}.`);
      }
      setOpenClawSuccess(result.message || `Test sent for ${adapterType}.`);
    } catch (err) {
      const message = (err as Error).message || `Failed to test adapter ${adapterType}.`;
      if (message.includes('Unknown adapter type')) {
        if (normalizedType === 'whatsapp') {
          setOpenClawError('WhatsApp test support is available in code, but your running wallet server is outdated. Restart AuraMaxx and test again.');
        } else {
          setOpenClawError(`${adapterType} does not support test yet.`);
        }
      } else if (message.includes('Telegram bot token not configured')) {
        setOpenClawError('Telegram bot token not configured. Enable Telegram and add the bot token in setup.');
      } else if (message.includes('Telegram chat ID not configured')) {
        setOpenClawError(message);
      } else {
        setOpenClawError(message);
      }
    } finally {
      setOpenClawTestingByType((prev) => ({ ...prev, [normalizedType]: false }));
    }
  }, [openClawAdapters]);

  const handleToggleTokenEditor = useCallback(async (adapterType: string) => {
    const isOpen = Boolean(openClawTokenEditorOpenByType[adapterType]);
    const nextOpen = !isOpen;
    setOpenClawTokenEditorOpenByType((prev) => ({ ...prev, [adapterType]: nextOpen }));
    if (!nextOpen) return;

    const existingDraft = openClawTokenDraftByType[adapterType];
    if (typeof existingDraft === 'string' && existingDraft.trim().length > 0) return;

    const normalizedType = adapterType.trim().toLowerCase();
    if (normalizedType !== 'telegram' && normalizedType !== 'discord') return;

    const adapter = openClawAdapters.find((entry) => entry.type === adapterType);
    if (normalizedType === 'discord') {
      const existingChannelId = readStringByKeys(adapter?.config, DISCORD_CHANNEL_ID_KEYS) || '';
      setOpenClawDiscordChannelDraftByType((prev) => ({ ...prev, [adapterType]: existingChannelId }));
    }

    try {
      const data = await api.get<AdapterSecretValueResponse>(
        Api.Wallet,
        `/adapters/${encodeURIComponent(normalizedType)}/secrets/${encodeURIComponent('botToken')}`,
      );
      const nextToken = typeof data.value === 'string' ? data.value.trim() : '';
      if (nextToken) {
        setOpenClawTokenDraftByType((prev) => ({ ...prev, [adapterType]: nextToken }));
      } else {
        setOpenClawTokenDraftByType((prev) => ({ ...prev, [adapterType]: '' }));
      }
    } catch (err) {
      const message = (err as Error).message || '';
      const isNotConfigured = message.includes('not configured') || message.includes('(404)');
      if (!isNotConfigured) {
        setOpenClawError(message || `Failed to load ${normalizedType} bot token.`);
      }
      setOpenClawTokenDraftByType((prev) => ({ ...prev, [adapterType]: '' }));
    }
  }, [openClawAdapters, openClawDiscordChannelDraftByType, openClawTokenDraftByType, openClawTokenEditorOpenByType]);

  const handleSaveAdapterToken = useCallback(async (adapterType: string) => {
    const adapter = openClawAdapters.find((entry) => entry.type === adapterType);
    if (!adapter) return;

    const normalizedType = adapter.type.trim().toLowerCase();
    const tokenDraft = (openClawTokenDraftByType[adapterType] || '').trim();
    const channelDraft = (openClawDiscordChannelDraftByType[adapterType] || '').trim();

    if (!tokenDraft) {
      setOpenClawError(`${adapter.type} bot token is required.`);
      return;
    }
    if (normalizedType === 'discord' && !channelDraft) {
      setOpenClawError('Discord channel ID is required.');
      return;
    }

    setOpenClawError(null);
    setOpenClawSuccess(null);
    setOpenClawTokenSavingByType((prev) => ({ ...prev, [adapterType]: true }));
    try {
      const payload: {
        type: string;
        enabled: boolean;
        config: Record<string, unknown>;
        chat?: { enabled?: boolean };
        secrets: Record<string, string>;
      } = {
        type: adapter.type,
        enabled: adapter.enabled,
        config: {
          ...(adapter.config || {}),
          ...(normalizedType === 'discord' ? { channelId: channelDraft } : {}),
        },
        secrets: { botToken: tokenDraft },
      };
      if (adapter.chat) {
        payload.chat = adapter.chat;
      }
      await api.post(Api.Wallet, '/adapters', payload);
      setOpenClawSuccess(`${adapter.type} settings saved.`);
      setOpenClawTokenDraftByType((prev) => ({ ...prev, [adapterType]: '' }));
      await loadAdaptersSummary();
    } catch (err) {
      setOpenClawError((err as Error).message || `Failed to save token for ${adapterType}.`);
    } finally {
      setOpenClawTokenSavingByType((prev) => ({ ...prev, [adapterType]: false }));
    }
  }, [loadAdaptersSummary, openClawAdapters, openClawDiscordChannelDraftByType, openClawTokenDraftByType]);

  const pollWhatsAppSetup = useCallback(async () => {
    try {
      const data = await api.get<WhatsAppSetupQrResponse>(Api.Wallet, '/adapters/whatsapp/setup-qr');
      const nextStatus = data.status || 'idle';
      setWhatsAppSetupStatus(nextStatus);
      setWhatsAppSetupQr(typeof data.qr === 'string' && data.qr.trim() ? data.qr : null);
      setWhatsAppSetupError(typeof data.error === 'string' && data.error.trim() ? data.error : null);

      if (nextStatus === 'connected' && whatsAppSetupStatus !== 'connected') {
        setOpenClawSuccess('WhatsApp linked successfully.');
        await loadAdaptersSummary();
        await api.post(Api.Wallet, '/adapters/restart', {});
      }
    } catch (err) {
      setWhatsAppSetupError((err as Error).message || 'Failed to read WhatsApp setup status.');
    }
  }, [loadAdaptersSummary, whatsAppSetupStatus]);

  const handleStartWhatsAppSetup = useCallback(async () => {
    setOpenClawError(null);
    setOpenClawSuccess(null);
    setWhatsAppSetupError(null);
    setWhatsAppSetupLoading(true);
    try {
      const data = await api.post<WhatsAppSetupQrResponse>(Api.Wallet, '/adapters/whatsapp/setup-qr', {});
      if (data.success === false) {
        throw new Error(data.error || 'Failed to start WhatsApp QR setup.');
      }
      const nextStatus = data.status || 'idle';
      setWhatsAppSetupStatus(nextStatus);
      setWhatsAppSetupQr(typeof data.qr === 'string' && data.qr.trim() ? data.qr : null);
      setWhatsAppSetupError(typeof data.error === 'string' && data.error.trim() ? data.error : null);
      if (nextStatus === 'connected') {
        setOpenClawSuccess('WhatsApp linked successfully.');
        await loadAdaptersSummary();
        await api.post(Api.Wallet, '/adapters/restart', {});
      }
    } catch (err) {
      setWhatsAppSetupError((err as Error).message || 'Failed to start WhatsApp setup.');
    } finally {
      setWhatsAppSetupLoading(false);
    }
  }, [loadAdaptersSummary]);

  const handleStopWhatsAppSetup = useCallback(async () => {
    try {
      await api.post(Api.Wallet, '/adapters/whatsapp/setup-qr/stop', {});
    } catch {
      // non-fatal
    } finally {
      setWhatsAppSetupStatus('idle');
      setWhatsAppSetupQr(null);
      setWhatsAppSetupError(null);
      setWhatsAppSetupLoading(false);
    }
  }, []);

  const handleDeleteAdapterChannel = useCallback(async (adapterType: string) => {
    const normalizedType = adapterType.trim().toLowerCase();
    setOpenClawError(null);
    setOpenClawSuccess(null);
    setOpenClawDeletingByType((prev) => ({ ...prev, [normalizedType]: true }));
    try {
      await api.delete(Api.Wallet, `/adapters/${encodeURIComponent(normalizedType)}`);
      await loadAdaptersSummary();
      setOpenClawSuccess(`Deleted ${adapterType} adapter.`);
    } catch (err) {
      setOpenClawError((err as Error).message || `Failed to delete adapter ${adapterType}.`);
    } finally {
      setOpenClawDeletingByType((prev) => ({ ...prev, [normalizedType]: false }));
    }
  }, [loadAdaptersSummary]);

  useEffect(() => {
    if (!adaptersOpen) return;
    if (whatsAppSetupStatus !== 'waiting_qr' && whatsAppSetupStatus !== 'qr_ready') return;

    void pollWhatsAppSetup();
    const interval = setInterval(() => {
      void pollWhatsAppSetup();
    }, 2_000);

    return () => clearInterval(interval);
  }, [adaptersOpen, pollWhatsAppSetup, whatsAppSetupStatus]);

  useEffect(() => {
    if (!isOpen) {
      if (whatsAppSetupStatus !== 'idle') {
        void handleStopWhatsAppSetup();
      }
      setAdaptersOpen(false);
      setOpenClawSuccess(null);
      setOpenClawError(null);
      setOpenClawChannelUpdatingByType({});
      setOpenClawTestingByType({});
      setOpenClawDeletingByType({});
      setOpenClawTokenEditorOpenByType({});
      setOpenClawTokenDraftByType({});
      setOpenClawDiscordChannelDraftByType({});
      setOpenClawTokenSavingByType({});
    }
  }, [handleStopWhatsAppSetup, isOpen, whatsAppSetupStatus]);

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title="Settings"
      subtitle="Local socket policy"
      footerLabel=""
    >
      <div className="space-y-4">
        {passwordChangeSuccess && (
          <div className="text-[10px] text-[var(--color-info)] border border-[var(--color-info)]/30 bg-[var(--color-info)]/10 px-3 py-2">
            {passwordChangeSuccess}
          </div>
        )}

        <TyvekCollapsibleSection
          title="Agent Theme"
          isOpen={agentThemeOpen}
          onToggle={onToggleAgentTheme}
          className="overflow-hidden"
          contentClassName="p-[var(--space-md)] border-t border-[var(--color-border)]"
        >
          <label className="block text-[9px] text-[var(--color-text-faint)] tracking-widest mb-2">Color mode</label>
          <ItemPicker
            options={[...agentColorModeOptions]}
            value={colorMode}
            onChange={(value) => onColorModeChange(value as ColorMode)}
          />
          <label className="block mt-3 text-[9px] text-[var(--color-text-faint)] tracking-widest mb-2">UI scale</label>
          <ItemPicker
            options={[...agentUiScaleOptions]}
            value={uiScale}
            onChange={(value) => onUiScaleChange(value as UiScale)}
          />
          <div className="mt-2 text-[9px] text-[var(--color-text-muted)]">
            Dark adjusts agent color contrast. Big increases typography, spacing, radius, and shadows.
          </div>
        </TyvekCollapsibleSection>

        <TyvekCollapsibleSection
          title="Agent Profile"
          icon={<Bot size={12} />}
          isOpen={agentSettingsOpen}
          onToggle={onToggleAgentSettings}
          className="overflow-hidden"
          contentClassName="px-4 pb-4 space-y-3 border-t border-[var(--color-border)]"
        >
          {policyLoadError && (
            <div className="space-y-2 pt-3">
              <div className="text-[10px] text-[var(--color-danger)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2">
                {policyLoadError}
              </div>
              <Button
                type="button"
                onClick={onRetryLoadPolicy}
                disabled={policyLoading}
                variant="secondary"
                size="md"
              >
                {policyLoading ? 'Retrying...' : 'Retry load'}
              </Button>
            </div>
          )}

          {!policyLoadError && (
            <>
              <div className="pt-3 flex items-center justify-between text-[10px] font-mono text-[var(--color-text)]">
                <span>Auto-approve local requests</span>
                <Toggle
                  size="sm"
                  checked={policyForm.autoApprove}
                  onChange={onPolicyAutoApproveChange}
                  disabled={policyLoading || policySaving}
                />
              </div>

              <div>
                <label className="block text-[9px] text-[var(--color-text-faint)] tracking-widest mb-2">Local profile</label>
                <ItemPicker
                  ariaLabel="Local profile"
                  options={[...localProfileOptions]}
                  value={policyForm.profile}
                  onChange={(value) => onPolicyProfileChange(value as LocalAgentMode)}
                  disabled={policyLoading || policySaving}
                />
              </div>

              <div>
                <label className="block text-[9px] text-[var(--color-text-faint)] tracking-widest mb-2">Project scope mode</label>
                <ItemPicker
                  ariaLabel="Project scope mode"
                  options={[...localProjectScopeOptions]}
                  value={policyForm.projectScopeMode}
                  onChange={(value) => onPolicyProjectScopeModeChange(value as ProjectScopeMode)}
                  disabled={policyLoading || policySaving}
                />
                <div className="mt-1 text-[9px] text-[var(--color-text-muted)]">
                  Strict requires `.aura` mappings for `get_secret`. Auto allows token-scope fallback when `.aura` is missing.
                </div>
              </div>

              {dangerConfirmOpen && (
                <div className="text-[10px] text-[var(--color-danger)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 space-y-2">
                  <div>Dangerous mode broadens local token scope (admin profile or super-scopes).</div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      onClick={onCancelDangerConfirm}
                      variant="secondary"
                      size="sm"
                      className="!h-8"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      onClick={onConfirmDangerousSave}
                      disabled={policySaving}
                      variant="danger"
                      size="sm"
                      className="!h-8"
                    >
                      Confirm dangerous mode
                    </Button>
                  </div>
                </div>
              )}

              <div className="text-[9px] text-[var(--color-text-muted)] px-3 py-2">
                Make sure you restart AuraMaxx to apply the new policy. Policy changes apply to newly issued local tokens only.
              </div>

              {policySaveError && <div className="text-[10px] text-[var(--color-danger)]">{policySaveError}</div>}
              {policySaveSuccess && <div className="text-[10px] text-[var(--color-info)]">{policySaveSuccess}</div>}

              <Button
                type="button"
                onClick={onSavePolicy}
                disabled={!canSavePolicy}
                variant="primary"
                size="lg"
                className="w-full"
              >
                {policySaving ? 'Saving...' : 'Save local policy'}
              </Button>
            </>
          )}
        </TyvekCollapsibleSection>

        <TyvekCollapsibleSection
          title="Primary Password"
          icon={<KeyRound size={12} />}
          isOpen={securitySettingsOpen}
          onToggle={onToggleSecuritySettings}
          className="overflow-hidden"
          contentClassName="px-4 pb-4 pt-3 space-y-3 border-t border-[var(--color-border)]"
        >
          <div className="text-[9px] text-[var(--color-text-muted)] leading-relaxed">
            Rotate your primary agent password. This updates the agent wrapper encryption and keeps existing credentials intact.
          </div>
          {passwordChangeError && (
            <div className="text-[10px] text-[var(--color-danger)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2">
              {passwordChangeError}
            </div>
          )}
          <Button
            type="button"
            onClick={onOpenPasswordModal}
            variant="secondary"
            size="lg"
            className="w-full"
          >
            Change primary password
          </Button>
        </TyvekCollapsibleSection>

        <TyvekCollapsibleSection
          title="Adapters (Beta)"
          icon={<Bot size={12} />}
          isOpen={adaptersOpen}
          onToggle={handleToggleAdapters}
          className="overflow-hidden"
          contentClassName="px-4 pb-4 pt-3 space-y-3 border-t border-[var(--color-border)]"
        >
          <div className="text-[9px] text-[var(--color-text-muted)] leading-relaxed">
            Enable and configure adapters to approve in a channel.
          </div>
          <div className="text-[9px] text-[var(--color-text-muted)] leading-relaxed">
            Note: If you use the same adapters as OpenClaw, it might cause race conditions.
          </div>

          {openClawSuccess && (
            <div className="text-[10px] text-[var(--color-info)] border border-[var(--color-info)]/30 bg-[var(--color-info)]/10 px-3 py-2">
              {openClawSuccess}
            </div>
          )}

          {openClawError && (
            <div className="text-[10px] text-[var(--color-danger)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2">
              {renderMessageWithLinks(openClawError)}
            </div>
          )}

          <div className="border-t border-dashed border-[var(--color-border)] pt-3 space-y-2">
            <div className="font-mono text-[9px] tracking-widest text-[var(--color-text-faint)]">EXISTING ADAPTERS</div>
            {openClawLoading ? (
              <div className="py-2 flex items-center justify-center">
                <Loader2 size={14} className="animate-spin text-[var(--color-text-muted)]" />
              </div>
            ) : openClawAdapters.length === 0 ? (
              <div className="text-[10px] text-[var(--color-text-muted)] px-2 py-1">
                No adapters configured yet.
              </div>
            ) : (
              <div className="space-y-1">
                {openClawAdapters.map((adapter) => {
                  const channelEnabled = Boolean(adapter.enabled && adapter.chat?.enabled);
                  const channelUpdating = Boolean(openClawChannelUpdatingByType[adapter.type]);
                  const adapterTypeKey = adapter.type.trim().toLowerCase();
                  const testing = Boolean(openClawTestingByType[adapterTypeKey]);
                  const deleting = Boolean(openClawDeletingByType[adapterTypeKey] || openClawDeletingByType[adapter.type]);
                  const tokenEditorOpen = Boolean(openClawTokenEditorOpenByType[adapter.type]);
                  const tokenSaving = Boolean(openClawTokenSavingByType[adapter.type]);
                  const tokenDraft = openClawTokenDraftByType[adapter.type] || '';
                  const botTokenConfigured = adapterTypeKey === 'telegram'
                    ? hasTelegramTokenConfigured(adapter)
                    : adapter.secretKeys?.includes('botToken');
                  const supportsSetupDropdown = adapterTypeKey === 'telegram' || adapterTypeKey === 'whatsapp' || adapterTypeKey === 'discord';
                  const qrImageUrl = whatsAppSetupQr
                    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=${encodeURIComponent(whatsAppSetupQr)}`
                    : null;
                  return (
                    <div
                      key={adapter.type}
                      className="border border-[var(--color-border)] bg-[var(--color-surface-alt)] px-2 py-2 text-[10px]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[var(--color-text)] uppercase tracking-wider">
                          {adapter.type}
                        </span>
                        <span className="flex items-center gap-2 text-[9px] text-[var(--color-text-muted)]">
                          {channelUpdating && <span>saving...</span>}
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => { void handleTestAdapterChannel(adapter.type); }}
                            disabled={channelUpdating || testing || deleting || tokenSaving || whatsAppSetupLoading}
                            loading={testing}
                          >
                            TEST
                          </Button>
                          <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            onClick={() => { void handleDeleteAdapterChannel(adapter.type); }}
                            disabled={channelUpdating || testing || deleting || tokenSaving || whatsAppSetupLoading}
                            loading={deleting}
                          >
                            DELETE
                          </Button>
                          <Toggle
                            size="sm"
                            checked={channelEnabled}
                            onChange={(checked) => { void handleToggleAdapterChannel(adapter.type, checked); }}
                            disabled={channelUpdating || testing || deleting || tokenSaving || whatsAppSetupLoading}
                          />
                          {supportsSetupDropdown && channelEnabled && (
                            <button
                              type="button"
                              onClick={() => { void handleToggleTokenEditor(adapter.type); }}
                              disabled={channelUpdating || testing || deleting || tokenSaving || whatsAppSetupLoading}
                              aria-label={tokenEditorOpen ? 'Hide adapter setup' : 'Show adapter setup'}
                              className="inline-flex h-5 w-5 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
                            >
                              {tokenEditorOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                            </button>
                          )}
                        </span>
                      </div>
                      {adapterTypeKey === 'telegram' && tokenEditorOpen && (
                        <div className="mt-2 border-t border-dashed border-[var(--color-border)] pt-2 space-y-2">
                          <div className="text-[9px] text-[var(--color-text-muted)]">
                            {botTokenConfigured ? 'Replace Telegram bot token' : 'Add Telegram bot token'}
                          </div>
                          <TextInput
                            type="password"
                            value={tokenDraft}
                            onChange={(event) => {
                              const next = event.target.value;
                              setOpenClawTokenDraftByType((prev) => ({ ...prev, [adapter.type]: next }));
                            }}
                            placeholder="123456:ABC..."
                            disabled={channelUpdating || testing || deleting || tokenSaving || whatsAppSetupLoading}
                            autoComplete="off"
                          />
                          <div className="text-[9px] text-[var(--color-text-muted)]">
                            Current token stays hidden. Enter a new token to replace it.
                          </div>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => { void handleSaveAdapterToken(adapter.type); }}
                            disabled={channelUpdating || testing || deleting || tokenSaving || whatsAppSetupLoading || !tokenDraft.trim()}
                            loading={tokenSaving}
                            className="w-full"
                          >
                            SAVE TOKEN
                          </Button>
                        </div>
                      )}
                      {adapterTypeKey === 'discord' && tokenEditorOpen && (
                        <div className="mt-2 border-t border-dashed border-[var(--color-border)] pt-2 space-y-2">
                          <div className="text-[9px] text-[var(--color-text-muted)]">
                            Add your Discord bot token and target channel ID.
                          </div>
                          <TextInput
                            type="password"
                            value={tokenDraft}
                            onChange={(event) => {
                              const next = event.target.value;
                              setOpenClawTokenDraftByType((prev) => ({ ...prev, [adapter.type]: next }));
                            }}
                            placeholder="Discord bot token"
                            disabled={channelUpdating || testing || deleting || tokenSaving || whatsAppSetupLoading}
                            autoComplete="off"
                          />
                          <TextInput
                            value={openClawDiscordChannelDraftByType[adapter.type] || ''}
                            onChange={(event) => {
                              const next = event.target.value;
                              setOpenClawDiscordChannelDraftByType((prev) => ({ ...prev, [adapter.type]: next }));
                            }}
                            placeholder="Discord channel ID"
                            disabled={channelUpdating || testing || deleting || tokenSaving || whatsAppSetupLoading}
                            autoComplete="off"
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => { void handleSaveAdapterToken(adapter.type); }}
                            disabled={channelUpdating || testing || deleting || tokenSaving || whatsAppSetupLoading || !tokenDraft.trim() || !(openClawDiscordChannelDraftByType[adapter.type] || '').trim()}
                            loading={tokenSaving}
                            className="w-full"
                          >
                            SAVE DISCORD SETTINGS
                          </Button>
                        </div>
                      )}
                      {adapterTypeKey === 'whatsapp' && tokenEditorOpen && (
                        <div className="mt-2 border-t border-dashed border-[var(--color-border)] pt-2 space-y-2">
                          <div className="text-[9px] text-[var(--color-text-muted)]">
                            Scan this QR code with WhatsApp to link Aura directly.
                          </div>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => { void handleStartWhatsAppSetup(); }}
                            loading={whatsAppSetupLoading}
                            disabled={channelUpdating || testing || deleting || tokenSaving || whatsAppSetupLoading}
                            className="w-full"
                          >
                            {whatsAppSetupStatus === 'connected' ? 'LINKED' : 'GENERATE QR'}
                          </Button>
                          {whatsAppSetupStatus === 'waiting_qr' && (
                            <div className="text-[9px] text-[var(--color-text-muted)]">Waiting for QR code...</div>
                          )}
                          {whatsAppSetupError && (
                            <div className="text-[9px] text-[var(--color-danger)]">{whatsAppSetupError}</div>
                          )}
                          {whatsAppSetupStatus === 'connected' && (
                            <div className="text-[9px] text-[var(--color-info)]">WhatsApp connected. You can approve actions from your phone.</div>
                          )}
                          {qrImageUrl && (
                            <div className="space-y-1">
                              <img
                                src={qrImageUrl}
                                alt="WhatsApp setup QR"
                                className="mx-auto h-[180px] w-[180px] border border-[var(--color-border)] bg-white"
                              />
                              <div className="text-[8px] text-[var(--color-text-faint)] leading-relaxed break-all">
                                QR payload: {whatsAppSetupQr}
                              </div>
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={() => { void handleStopWhatsAppSetup(); }}
                                className="w-full"
                              >
                                STOP QR
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </TyvekCollapsibleSection>

        <TyvekCollapsibleSection
          title="Database Backup"
          icon={<Database size={12} />}
          isOpen={backupSectionOpen}
          onToggle={onToggleBackupSection}
          className="overflow-hidden"
          contentClassName="px-4 pb-4 pt-3 space-y-3 border-t border-[var(--color-border)]"
        >
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={onCreateBackup}
              disabled={creatingBackup}
              loading={creatingBackup}
              icon={!creatingBackup ? <Plus size={12} /> : undefined}
              className="flex-1"
            >
              {creatingBackup ? 'CREATING...' : 'CREATE BACKUP'}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={onExportDb}
              disabled={exportingDb}
              loading={exportingDb}
              icon={!exportingDb ? <Database size={12} /> : undefined}
              className="flex-1"
            >
              {exportingDb ? 'EXPORTING...' : 'EXPORT DB'}
            </Button>
          </div>

          {backupsLoading ? (
            <div className="py-4 flex items-center justify-center">
              <Loader2 size={16} className="animate-spin text-[var(--color-text-muted)]" />
            </div>
          ) : backups.length === 0 ? (
            <div className="py-3 text-center">
              <div className="font-mono text-[9px] text-[var(--color-text-muted)]">No backups found</div>
            </div>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {backups.map((backup) => (
                <div key={backup.filename} className="relative">
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    onClick={(event) => {
                      onOpenRestoreConfirm(backup.filename, event.currentTarget as unknown as HTMLElement);
                    }}
                    className="w-full !h-auto !px-2 !py-2 !justify-between group"
                  >
                    <div className="flex items-center gap-2">
                      <RotateCcw size={10} className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]" />
                      <span className="font-mono text-[10px] text-[var(--color-text)]">
                        {formatBackupDate(backup.timestamp)}
                      </span>
                    </div>
                    <span className="font-mono text-[9px] text-[var(--color-text-muted)]">
                      {formatSize(backup.size)}
                    </span>
                  </Button>
                  <ConfirmationModal
                    isOpen={restoreConfirmOpen === backup.filename}
                    onClose={onCloseRestoreConfirm}
                    onConfirm={() => onConfirmRestore(backup.filename)}
                    title="Restore Backup"
                    message="Restore to this backup? You will lose all data since this backup was created."
                    confirmText="RESTORE"
                    variant="warning"
                    loading={restoringBackup === backup.filename}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="pt-2 border-t border-dashed border-[var(--color-border)]">
            <div className="font-mono text-[8px] text-[var(--color-text-faint)] leading-relaxed">
              Backups are tied to the current database schema. Restoring after migrations may cause issues.
            </div>
          </div>
        </TyvekCollapsibleSection>

        <TyvekCollapsibleSection
          title="Danger Zone"
          isOpen={dangerZoneOpen}
          onToggle={onToggleDangerZone}
          tone="warning"
          className="overflow-hidden"
          contentClassName="space-y-3 p-[var(--space-md)] border-t border-[var(--color-border)]"
        >
          <div className="text-[9px] text-[var(--color-warning)] leading-relaxed">
            Permanently delete your agent, wallets, credentials, and local configuration. This action cannot be undone.
          </div>
          {nukeError && (
            <div
              className="text-[10px] border px-3 py-2"
              style={{
                color: 'var(--color-warning)',
                borderColor: 'color-mix(in srgb, var(--color-warning) 30%, transparent)',
                background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)',
              }}
            >
              {nukeError}
            </div>
          )}
          <Button
            type="button"
            onClick={onOpenNukeConfirm}
            disabled={nuking}
            variant="danger"
            size="lg"
            className="w-full"
          >
            {nuking ? 'Nuking...' : 'Nuke'}
          </Button>
        </TyvekCollapsibleSection>
      </div>
    </Drawer>
  );
}
