'use client';

import { useState, useEffect, useCallback, useMemo, useRef, CSSProperties } from 'react';
import * as bip39 from 'bip39';
import Link from 'next/link';
import { Fingerprint, Settings, CircleHelp } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { api, Api, unlockWallet, setupWallet, rekeySession, changePrimaryAgentPassword, recoverWalletAccess } from '@/lib/api';
import { generateAgentKeypair, getAgentPrivateKey } from '@/lib/agent-crypto';
import { CredentialAgent } from '@/components/agent/CredentialAgent';
import { NotificationDrawer } from '@/components/NotificationDrawer';
import { SettingsDrawer } from '@/components/layout/SettingsDrawer';
import { LeftRail } from '@/components/layout/LeftRail';
import { DEFAULT_VIEWS, SOCIAL_VIEW, HUB_VIEW } from '@/lib/view-registry';
import { VerificationView } from '@/components/agents/AgentsView';
import { SocialView } from '@/components/social/SocialView';
import { HubView } from '@/components/hub/HubView';
import { PrimaryHubRegistrationGate } from '@/components/social/PrimaryHubRegistrationGate';
import { fetchHubSubscriptions, fetchPrimaryHubUrl, joinHub, leaveHub, type HubSubscriptionInfo } from '@/lib/social-client';
import { useAgentActions } from '@/hooks/useAgentActions';
import DocsThemeToggle from '@/components/docs/DocsThemeToggle';
import { Modal, Button, ItemPicker, TextInput, ConfirmationModal } from '@/components/design-system';
import { PasskeyEnrollmentPrompt } from '@/components/PasskeyEnrollmentPrompt';
import { UpdateBanner } from '@/components/UpdateBanner';
import { START_BANNER_QUOTES, getNextStartBannerQuote } from '@/lib/startBannerQuotes';
import { useTheme, type ColorMode, type UiScale } from '@/hooks/useTheme';

interface AgentInfo {
  id: string;
  name?: string;
  address: string;
  solanaAddress?: string;
  isUnlocked: boolean;
  isPrimary: boolean;
  createdAt: string;
}

interface WalletData {
  address: string;
  tier: 'cold' | 'hot' | 'temp';
  chain: string;
  balance?: string;
}

type PageState = 'loading' | 'setup' | 'locked' | 'transition' | 'unlocked';
type LocalAgentMode = 'strict' | 'dev' | 'admin';
type ProjectScopeMode = 'auto' | 'strict' | 'off';
type SetupOnboardingStep = 'seed' | 'trust';
type SeedPhraseActionStatus = 'copied' | 'copy-failed' | 'downloaded' | 'download-failed';
type LocalPolicySettings = {
  profile: LocalAgentMode;
  profileVersion: 'v1';
  autoApprove: boolean;
  projectScopeMode: ProjectScopeMode;
};

const LOCAL_POLICY_PROFILES: LocalAgentMode[] = ['admin', 'dev', 'strict'];
const LOCAL_PROJECT_SCOPE_MODES: ProjectScopeMode[] = ['auto', 'strict', 'off'];
const LOCAL_PROFILE_ITEM_OPTIONS = [
  {
    value: 'admin',
    label: 'maxx (admin)',
    description: 'Full access. Use only when you fully trust the agent.',
  },
  {
    value: 'dev',
    label: 'mid (dev)',
    description: 'Access to most things. Human approval for stuff like CVV.',
  },
  {
    value: 'strict',
    label: 'sus (local)',
    description: 'Most locked down. Every request needs manual approval.',
  },
] as const;
const LOCAL_PROJECT_SCOPE_ITEM_OPTIONS = [
  {
    value: 'auto',
    label: 'auto (recommended)',
    description: 'Uses `.aura` when present and safely falls back to token scope when missing.',
  },
  {
    value: 'strict',
    label: 'strict (require .aura)',
    description: 'Requires explicit `.aura` mappings for secret access.',
  },
  {
    value: 'off',
    label: 'off (disable project allowlist)',
    description: 'Disables project allowlist checks for local token access.',
  },
] as const;
const ONBOARDING_LOCAL_AGENT_MODE_OPTIONS = [
  {
    value: 'dev',
    label: 'mid (dev)',
    description: 'Access to most things. Human approval for stuff like CVV.',
  },
  {
    value: 'strict',
    label: 'sus (local)',
    description: 'Most locked down. Every request needs manual approval.',
  },
  {
    value: 'admin',
    label: 'maxx (admin)',
    description: 'Full access. Use only when you fully trust the agent.',
  },
] as const;
const AGENT_COLOR_MODE_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;
const AGENT_UI_SCALE_OPTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'big', label: 'Big' },
] as const;
const FAVORITE_HUBS_STORAGE_KEY = 'aura:favoriteHubUrls';

function normalizeHubUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

type OnboardingSeedDraft = {
  mnemonic: string;
  createdAt: number;
};

const ONBOARDING_SEED_STORAGE_KEY = 'aura:onboarding-seed-draft';
const ONBOARDING_SEED_TTL_MS = 15 * 60 * 1000;
const DASHBOARD_TRANSITION_TIMEOUT_MS = 1500;
const LOADER_EXIT_DURATION_MS = 220;
const LOCK_STATE_RECHECK_MS = 450;
const TOKEN_HYDRATION_GRACE_MS = 120;
const TOKEN_STORAGE_KEY = 'auramaxx_admin_token';
const BIP39_WORD_SET = new Set((bip39.wordlists.english as string[]).map((word) => word.toLowerCase()));

const normalizeRecoveryWords = (raw: string): string[] => raw
  .trim()
  .toLowerCase()
  .split(/\s+/)
  .filter(Boolean);

const UNLOCK_MARQUEE_REPEAT = 4;
const UNLOCK_SPRITES = [
  { src: '/agent9.png', label: 'Agent 1', width: 'clamp(24px, 3.8vw, 40px)', height: 'clamp(34px, 5.6vw, 58px)', baselineOffset: 'clamp(4px, 0.8vw, 8px)', spriteY: '0%', cropBottom: '4px' },
  { src: '/agent10.png', label: 'Agent 2', width: 'clamp(28px, 4.4vw, 46px)', height: 'clamp(40px, 6.4vw, 66px)', baselineOffset: '0px', spriteY: '0%', cropBottom: '0px' },
  { src: '/agent1.png', label: 'Agent 3', width: 'clamp(28px, 4.4vw, 46px)', height: 'clamp(40px, 6.4vw, 66px)', baselineOffset: '0px', spriteY: '0%', cropBottom: '0px' },
  { src: '/agent2.png', label: 'Agent 4', width: 'clamp(28px, 4.4vw, 46px)', height: 'clamp(40px, 6.4vw, 66px)', baselineOffset: '0px', spriteY: '0%', cropBottom: '0px' },
  { src: '/agent3.png', label: 'Agent 5', width: 'clamp(28px, 4.4vw, 46px)', height: 'clamp(40px, 6.4vw, 66px)', baselineOffset: '0px', spriteY: '0%', cropBottom: '0px' },
  { src: '/agent4.png', label: 'Agent 6', width: 'clamp(28px, 4.4vw, 46px)', height: 'clamp(40px, 6.4vw, 66px)', baselineOffset: '0px', spriteY: '0%', cropBottom: '0px' },
  { src: '/agent5.png', label: 'Agent 7', width: 'clamp(28px, 4.4vw, 46px)', height: 'clamp(40px, 6.4vw, 66px)', baselineOffset: '0px', spriteY: '0%', cropBottom: '0px' },
  { src: '/agent6.png', label: 'Agent 8', width: 'clamp(28px, 4.4vw, 46px)', height: 'clamp(40px, 6.4vw, 66px)', baselineOffset: '0px', spriteY: '0%', cropBottom: '0px' },
  { src: '/agent7.png', label: 'Agent 9', width: 'clamp(28px, 4.4vw, 46px)', height: 'clamp(40px, 6.4vw, 66px)', baselineOffset: '0px', spriteY: '0%', cropBottom: '0px' },
  { src: '/agent8.png', label: 'Agent 10', width: 'clamp(28px, 4.4vw, 46px)', height: 'clamp(40px, 6.4vw, 66px)', baselineOffset: '0px', spriteY: '0%', cropBottom: '0px' },
] as const;

function spriteHashSeed(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function spriteSeededUnit(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getSpriteScatterStyle(src: string, index: number, rowIndex = 0): CSSProperties {
  const base = spriteHashSeed(src) + (index * 97) + (rowIndex * 131);
  const x = (spriteSeededUnit(base + 1) - 0.5) * 8;
  const y = (spriteSeededUnit(base + 2) - 0.5) * 4 + (rowIndex === 0 ? -1.5 : 1.5);
  const r = (spriteSeededUnit(base + 3) - 0.5) * 5;
  const ml = (spriteSeededUnit(base + 4) - 0.5) * 8;
  const mr = (spriteSeededUnit(base + 5) - 0.5) * 8;
  const scale = 0.72 + (spriteSeededUnit(base + 6) * 0.06);

  return {
    marginLeft: `${Math.round(ml)}px`,
    marginRight: `${Math.round(mr)}px`,
    transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${r.toFixed(1)}deg) scale(${scale.toFixed(3)})`,
  };
}

export default function UnlockPage() {
  const { token, setToken, clearToken } = useAuth();
  const { colorMode, uiScale, setColorMode, setUiScale } = useTheme();

  const [pageState, setPageState] = useState<PageState>('loading');
  const [password, setPassword] = useState('');
  const [trustDevice, setTrustDevice] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [seedAcknowledged, setSeedAcknowledged] = useState(false);
  const [seedRecoveryNotice, setSeedRecoveryNotice] = useState<string | null>(null);
  const [seedPhraseActionStatus, setSeedPhraseActionStatus] = useState<SeedPhraseActionStatus | null>(null);
  const [loaderExiting, setLoaderExiting] = useState(false);
  const [localAgentMode, setLocalAgentMode] = useState<LocalAgentMode>('admin');
  const [setupOnboardingStep, setSetupOnboardingStep] = useState<SetupOnboardingStep>('seed');
  const [onboardingToken, setOnboardingToken] = useState<string | null>(null);
  const [dashboardTransitionTimedOut, setDashboardTransitionTimedOut] = useState(false);
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false);
  const { notifications: pageNotifications, dismissNotification: pageDismissNotification } = useAgentActions({ autoFetch: !!token });
  const [nukeConfirmOpen, setNukeConfirmOpen] = useState(false);
  const [nuking, setNuking] = useState(false);
  const [nukeError, setNukeError] = useState<string | null>(null);
  const [policySettings, setPolicySettings] = useState<LocalPolicySettings | null>(null);
  const [policyForm, setPolicyForm] = useState<LocalPolicySettings>({
    profile: 'admin',
    profileVersion: 'v1',
    autoApprove: true,
    projectScopeMode: 'off',
  });
  const [policyLoadError, setPolicyLoadError] = useState<string | null>(null);
  const [policySaveError, setPolicySaveError] = useState<string | null>(null);
  const [policyFormErrors, setPolicyFormErrors] = useState<Record<string, string>>({});
  const [policySaveSuccess, setPolicySaveSuccess] = useState<string | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [dangerConfirmOpen, setDangerConfirmOpen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [agentThemeOpen, setAgentThemeOpen] = useState(true);
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [securitySettingsOpen, setSecuritySettingsOpen] = useState(false);
  const [dangerZoneOpen, setDangerZoneOpen] = useState(false);
  const [backupSectionOpen, setBackupSectionOpen] = useState(false);
  const [backups, setBackups] = useState<Array<{ filename: string; timestamp: string; size: number; date: string }>>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);
  const [exportingDb, setExportingDb] = useState(false);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState<string | null>(null);
  const [restoreAnchorEl, setRestoreAnchorEl] = useState<HTMLElement | null>(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPasswordValue, setCurrentPasswordValue] = useState('');
  const [newPasswordValue, setNewPasswordValue] = useState('');
  const [confirmPasswordValue, setConfirmPasswordValue] = useState('');
  const [passwordChangeError, setPasswordChangeError] = useState<string | null>(null);
  const [passwordChangeSuccess, setPasswordChangeSuccess] = useState<string | null>(null);
  const [passwordChanging, setPasswordChanging] = useState(false);
  const [showSeedRecovery, setShowSeedRecovery] = useState(false);
  const [experimentalWalletEnabled, setExperimentalWalletEnabled] = useState(false);
  const [socialEnabled, setSocialEnabled] = useState(false);
  const [showDiscoverHub, setShowDiscoverHub] = useState(false);
  const [activeViewId, setActiveViewId] = useState(() => {
    if (typeof window === 'undefined') return 'main';
    return localStorage.getItem('aura:activeViewId') ?? 'main';
  });
  const handleSelectView = (id: string) => {
    setActiveViewId(id);
    localStorage.setItem('aura:activeViewId', id);
  };

  // Hub multi-server state
  const [hubs, setHubs] = useState<HubSubscriptionInfo[]>([]);
  const [activeHubUrl, setActiveHubUrl] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('aura:activeHubUrl') ?? '';
  });
  const [showAddHub, setShowAddHub] = useState(false);
  const [addHubUrl, setAddHubUrl] = useState('');
  const [addHubLabel, setAddHubLabel] = useState('');
  const [addHubLoading, setAddHubLoading] = useState(false);
  const [addHubError, setAddHubError] = useState<string | null>(null);
  const [hubActionError, setHubActionError] = useState<string | null>(null);
  const [defaultHubUrl, setDefaultHubUrl] = useState<string>('');
  const [favoriteHubUrls, setFavoriteHubUrls] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(FAVORITE_HUBS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const normalized = parsed
        .filter((value): value is string => typeof value === 'string')
        .map((value) => normalizeHubUrl(value))
        .filter(Boolean);
      return Array.from(new Set(normalized));
    } catch {
      return [];
    }
  });

  const handleSelectHub = useCallback((hubUrl: string) => {
    const normalized = normalizeHubUrl(hubUrl);
    setActiveHubUrl(normalized);
    localStorage.setItem('aura:activeHubUrl', normalized);
  }, []);

  const fetchPrimarySocialAgentId = useCallback(async (): Promise<string> => {
    const agentsRes = await api.get<{ agents: { id: string; isPrimary: boolean; parentAgentId?: string }[] }>(
      Api.Wallet,
      '/agents/credential',
    );
    const agents = agentsRes.agents || [];
    const primary = agents.find((agent) => agent.isPrimary && !agent.parentAgentId);
    if (!primary) {
      throw new Error('No primary agent found');
    }
    return primary.id;
  }, []);

  const loadHubs = useCallback(async () => {
    try {
      const primaryAgentId = await fetchPrimarySocialAgentId();
      const [loadedHubs, configuredDefaultHubUrl] = await Promise.all([
        fetchHubSubscriptions(primaryAgentId),
        fetchPrimaryHubUrl().catch(() => ''),
      ]);

      const normalizedDefaultHubUrl = normalizeHubUrl(configuredDefaultHubUrl);
      const explicitHubs = normalizedDefaultHubUrl
        ? loadedHubs.filter((hub) => normalizeHubUrl(hub.hubUrl) !== normalizedDefaultHubUrl)
        : loadedHubs;

      setDefaultHubUrl(normalizedDefaultHubUrl);
      setHubs(explicitHubs);
      setFavoriteHubUrls((current) => {
        const availableUrls = new Set(explicitHubs.map((hub) => normalizeHubUrl(hub.hubUrl)));
        const next = current.filter((url) => availableUrls.has(url));
        return next.length === current.length ? current : next;
      });
      // If no active hub selected but we have hubs, select the first one
      setActiveHubUrl((current) => {
        if (current && explicitHubs.some((h) => h.hubUrl === current)) return current;
        return explicitHubs.length > 0 ? explicitHubs[0].hubUrl : '';
      });
    } catch {
      // non-fatal
    }
  }, [fetchPrimarySocialAgentId]);

  // Load hubs when social is enabled
  useEffect(() => {
    if (socialEnabled) {
      void loadHubs();
    }
  }, [socialEnabled, loadHubs]);

  useEffect(() => {
    localStorage.setItem(FAVORITE_HUBS_STORAGE_KEY, JSON.stringify(favoriteHubUrls));
  }, [favoriteHubUrls]);

  const handleJoinHub = useCallback(async () => {
    const url = addHubUrl.trim();
    if (!url || addHubLoading) return;
    setAddHubLoading(true);
    setAddHubError(null);
    try {
      const primaryAgentId = await fetchPrimarySocialAgentId();
      await joinHub(primaryAgentId, url, addHubLabel.trim() || undefined);
      await loadHubs();
      setShowAddHub(false);
      setAddHubUrl('');
      setAddHubLabel('');
      handleSelectHub(normalizeHubUrl(url));
    } catch (err) {
      setAddHubError(err instanceof Error ? err.message : 'Failed to join hub');
    } finally {
      setAddHubLoading(false);
    }
  }, [addHubUrl, addHubLabel, addHubLoading, fetchPrimarySocialAgentId, loadHubs, handleSelectHub]);

  const handleToggleFavoriteHub = useCallback((hub: HubSubscriptionInfo) => {
    const normalizedUrl = normalizeHubUrl(hub.hubUrl);
    if (!normalizedUrl) return;

    setFavoriteHubUrls((current) => {
      if (current.includes(normalizedUrl)) {
        return current.filter((url) => url !== normalizedUrl);
      }
      return [normalizedUrl, ...current.filter((url) => url !== normalizedUrl)];
    });
  }, []);

  const handleRemoveHub = useCallback(async (hub: HubSubscriptionInfo) => {
    const normalizedUrl = normalizeHubUrl(hub.hubUrl);
    if (!normalizedUrl) return;
    if (defaultHubUrl && normalizedUrl === defaultHubUrl) {
      setHubActionError('Default hub cannot be removed.');
      return;
    }

    try {
      const primaryAgentId = await fetchPrimarySocialAgentId();
      await leaveHub(primaryAgentId, normalizedUrl);
      setFavoriteHubUrls((current) => current.filter((url) => url !== normalizedUrl));
      await loadHubs();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove hub';
      setHubActionError(message);
    }
  }, [defaultHubUrl, fetchPrimarySocialAgentId, loadHubs]);

  const [installedVersion, setInstalledVersion] = useState('unknown');
  const [recoveryWordCount, setRecoveryWordCount] = useState<12 | 24>(12);
  const [recoveryWords, setRecoveryWords] = useState<string[]>(Array(12).fill(''));

  // Passkey biometric unlock state
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [startBannerQuote] = useState<string>(() => {
    if (typeof window === 'undefined') return START_BANNER_QUOTES[0];
    try {
      return getNextStartBannerQuote(window.localStorage);
    } catch {
      return START_BANNER_QUOTES[0];
    }
  });
  const [recoveryNewPassword, setRecoveryNewPassword] = useState('');
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const pageStateRef = useRef<PageState>('loading');
  const loaderExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPageStateRef = useRef<PageState | null>(null);
  const mountedRef = useRef(true);
  const fetchStateRunIdRef = useRef(0);
  const rekeyInFlightRef = useRef<Promise<{ success: boolean; token: string }> | null>(null);

  const hasPendingSeedConfirmation = useMemo(() => Boolean(mnemonic), [mnemonic]);
  const pendingHumanActionCount = useMemo(
    () => pageNotifications.filter((notification) => notification.status === 'pending' && notification.type !== 'notify').length,
    [pageNotifications],
  );
  const utilityLinksBottomOffset = useMemo(
    () => (pendingHumanActionCount > 0 ? 'calc(4rem + 3.5rem)' : '4rem'),
    [pendingHumanActionCount],
  );
  const recoveryWordsFilled = useMemo(() => recoveryWords.filter((word) => word.length > 0).length, [recoveryWords]);
  const normalizedRecoveryPhrase = useMemo(() => recoveryWords.map((word) => word.trim().toLowerCase()).join(' ').trim(), [recoveryWords]);
  const invalidRecoveryIndexes = useMemo(() => {
    const invalid = new Set<number>();
    recoveryWords.forEach((word, index) => {
      if (!word) return;
      if (!BIP39_WORD_SET.has(word.trim().toLowerCase())) {
        invalid.add(index);
      }
    });
    return invalid;
  }, [recoveryWords]);
  const isRecoveryPhraseStructurallyValid = useMemo(() => {
    if (recoveryWordsFilled !== recoveryWordCount) return false;
    if (invalidRecoveryIndexes.size > 0) return false;
    return bip39.validateMnemonic(normalizedRecoveryPhrase);
  }, [invalidRecoveryIndexes.size, normalizedRecoveryPhrase, recoveryWordCount, recoveryWordsFilled]);

  const marqueeSprites = useMemo(
    () => Array.from({ length: UNLOCK_MARQUEE_REPEAT }, () => UNLOCK_SPRITES).flat(),
    [],
  );

  const isDangerousPolicySelection = useCallback((settings: LocalPolicySettings) => {
    return settings.profile === 'admin';
  }, []);

  const policyFormDirty = useMemo(() => {
    if (!policySettings) return false;
    return JSON.stringify(policySettings) !== JSON.stringify(policyForm);
  }, [policyForm, policySettings]);

  useEffect(() => {
    try {
      const rawDraft = sessionStorage.getItem(ONBOARDING_SEED_STORAGE_KEY);
      if (!rawDraft) return;
      const parsed = JSON.parse(rawDraft) as OnboardingSeedDraft;
      if (!parsed?.mnemonic || typeof parsed.createdAt !== 'number') {
        sessionStorage.removeItem(ONBOARDING_SEED_STORAGE_KEY);
        return;
      }
      if (Date.now() - parsed.createdAt > ONBOARDING_SEED_TTL_MS) {
        sessionStorage.removeItem(ONBOARDING_SEED_STORAGE_KEY);
        setSeedRecoveryNotice('Recovery phrase draft expired. Restart setup to generate a new phrase.');
        return;
      }

      setMnemonic(parsed.mnemonic);
      setSetupOnboardingStep('seed');
      setPageState('setup');
      setSeedRecoveryNotice('Recovered your in-progress recovery phrase for this tab. Confirm after you store it safely.');
    } catch {
      sessionStorage.removeItem(ONBOARDING_SEED_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!mnemonic) {
      sessionStorage.removeItem(ONBOARDING_SEED_STORAGE_KEY);
      setSetupOnboardingStep('seed');
      setSeedPhraseActionStatus(null);
      return;
    }
    const draft: OnboardingSeedDraft = {
      mnemonic,
      createdAt: Date.now(),
    };
    sessionStorage.setItem(ONBOARDING_SEED_STORAGE_KEY, JSON.stringify(draft));
  }, [mnemonic]);

  useEffect(() => {
    if (pageState !== 'locked') {
      setShowSeedRecovery(false);
    }
  }, [pageState]);

  useEffect(() => {
    pageStateRef.current = pageState;
  }, [pageState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (loaderExitTimerRef.current) {
        clearTimeout(loaderExitTimerRef.current);
      }
    };
  }, []);

  const queuePageStateAfterLoader = useCallback((nextState: PageState) => {
    const currentState = pageStateRef.current;
    if (currentState === 'loading' || currentState === 'transition') {
      if (pendingPageStateRef.current === nextState) return;
      pendingPageStateRef.current = nextState;
      setLoaderExiting(true);
      if (loaderExitTimerRef.current) {
        clearTimeout(loaderExitTimerRef.current);
      }
      loaderExitTimerRef.current = setTimeout(() => {
        setLoaderExiting(false);
        pendingPageStateRef.current = null;
        setPageState(nextState);
      }, LOADER_EXIT_DURATION_MS);
      return;
    }

    if (loaderExitTimerRef.current) {
      clearTimeout(loaderExitTimerRef.current);
      loaderExitTimerRef.current = null;
    }
    pendingPageStateRef.current = null;
    setLoaderExiting(false);
    setPageState(nextState);
  }, []);

  const beginTransitionState = useCallback(() => {
    if (loaderExitTimerRef.current) {
      clearTimeout(loaderExitTimerRef.current);
      loaderExitTimerRef.current = null;
    }
    pendingPageStateRef.current = null;
    setLoaderExiting(false);
    setPageState('transition');
  }, []);

  // Check if passkey biometric unlock is usable (registered + agent unlocked server-side)
  useEffect(() => {
    if (pageState !== 'locked') {
      setPasskeyAvailable(false);
      return;
    }
    if (typeof window === 'undefined' || !window.PublicKeyCredential) return;
    // Electron's Chromium reports WebAuthn as available but the sandbox
    // can't complete the ceremony — skip passkey in desktop app.
    if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).auraDesktop) return;

    let cancelled = false;
    (async () => {
      try {
        const status = await api.get<{ registered: boolean }>(Api.Wallet, '/auth/passkey/status');
        if (cancelled || !status.registered) return;
        // Probe authenticate/options to confirm agent is unlocked server-side.
        // If the server returns agent_locked, biometric auth won't work.
        await api.post(Api.Wallet, '/auth/passkey/authenticate/options', {});
        if (!cancelled) setPasskeyAvailable(true);
      } catch { /* agent_locked or no passkeys — hide button */ }
    })();
    return () => { cancelled = true; };
  }, [pageState]);

  const fetchState = useCallback(async () => {
    const runId = ++fetchStateRunIdRef.current;
    const canMutate = () => mountedRef.current && runId === fetchStateRunIdRef.current;
    let activeToken = token;
    if (!activeToken && typeof window !== 'undefined') {
      const localToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
      const sessionToken = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
      const recoveredToken = localToken || sessionToken;
      if (recoveredToken) {
        const persist = localToken ? 'local' : 'session';
        setToken(recoveredToken, { persist });
        // Allow the auth context to re-render with the recovered token before
        // resolving page state; this avoids a brief locked-screen flash.
        return;
      }
    }

    // Page reload recovery: keypair is memory-only and lost on reload.
    // If token exists but keypair is gone, regenerate keypair and re-key the session.
    if (activeToken && !getAgentPrivateKey()) {
      try {
        if (!rekeyInFlightRef.current) {
          rekeyInFlightRef.current = (async () => {
            const { publicKeyBase64 } = await generateAgentKeypair();
            return rekeySession(publicKeyBase64);
          })()
            .finally(() => {
              rekeyInFlightRef.current = null;
            });
        }

        const result = await rekeyInFlightRef.current;
        if (!canMutate()) return;
        if (result.token) {
          setToken(result.token);
          activeToken = result.token;
        }
        // Keypair restored, continue to fetch state normally
      } catch {
        if (!canMutate()) return;
        // Re-key failed (token expired, server restarted, agent locked, or no agent yet).
        // Clear stale token and continue with setup status checks.
        clearToken();
        activeToken = null;
      }
    }

    try {
      // Use /setup (lightweight status check) instead of /wallets (which fetches RPC balances
      // and can hang on cold start). /setup only checks in-memory agent state — no RPC calls.
      const [status, agentData] = await Promise.all([
        api.get<{ hasWallet: boolean; unlocked: boolean }>(Api.Wallet, '/setup'),
        api.get<{ agents: AgentInfo[] }>(Api.Wallet, '/setup/agents'),
      ]);
      if (!canMutate()) return;

      const agents = Array.isArray(agentData.agents) ? agentData.agents : [];
      const configured = status.hasWallet || agents.some(v => v.isPrimary) || agents.length > 0;

      if (!configured) {
        queuePageStateAfterLoader('setup');
        return;
      }

      if (hasPendingSeedConfirmation) {
        queuePageStateAfterLoader('setup');
        return;
      }

      const isInitialResolution =
        pageStateRef.current === 'loading' || pageStateRef.current === 'transition';
      if (status.unlocked && !activeToken && isInitialResolution) {
        try {
          await new Promise((resolve) => setTimeout(resolve, TOKEN_HYDRATION_GRACE_MS));
          if (!canMutate()) return;

          const localToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
          const sessionToken = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
          const recoveredToken = localToken || sessionToken;
          if (recoveredToken) {
            setToken(recoveredToken, { persist: localToken ? 'local' : 'session' });
            return;
          }
        } catch {
          if (!canMutate()) return;
        }
      }

      if (!status.unlocked && activeToken && isInitialResolution) {
        try {
          await new Promise((resolve) => setTimeout(resolve, LOCK_STATE_RECHECK_MS));
          if (!canMutate()) return;
          const retryStatus = await api.get<{ hasWallet: boolean; unlocked: boolean }>(Api.Wallet, '/setup');
          if (!canMutate()) return;
          if (retryStatus.unlocked) {
            queuePageStateAfterLoader('unlocked');
            return;
          }
        } catch {
          if (!canMutate()) return;
        }
      }

      if (!status.unlocked || !activeToken) {
        queuePageStateAfterLoader('locked');
        return;
      }

      queuePageStateAfterLoader('unlocked');
    } catch {
      if (!canMutate()) return;
      queuePageStateAfterLoader('setup');
    }
  }, [token, clearToken, hasPendingSeedConfirmation, queuePageStateAfterLoader, setToken]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  const loadLocalPolicySettings = useCallback(async () => {
    if (!token) {
      setPolicyLoadError('Unlock agent first to manage local socket policy.');
      return;
    }

    setPolicyLoading(true);
    setPolicyLoadError(null);
    setPolicySaveError(null);
    setPolicySaveSuccess(null);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const baseUrl = api.getBaseUrl(Api.Wallet);
      const defaultsRes = await fetch(`${baseUrl}/defaults`, { headers });
      if (!defaultsRes.ok) {
        throw new Error('Failed to load canonical trust policy defaults.');
      }

      const defaultsJson = await defaultsRes.json() as {
        success?: boolean;
        defaults?: Record<string, Array<{ key: string; value: unknown }>>;
      };
      if (defaultsJson.success === false) {
        throw new Error('Failed to load canonical trust policy defaults.');
      }
      const flatDefaults = Object.values(defaultsJson.defaults || {}).flat();
      const findDefault = (key: string): unknown => flatDefaults.find((item) => item.key === key)?.value;

      const loadedProfile = String(findDefault('trust.localProfile') ?? '').trim() as LocalAgentMode;
      if (!LOCAL_POLICY_PROFILES.includes(loadedProfile)) {
        throw new Error(`Unknown persisted local profile: ${loadedProfile || '(empty)'}`);
      }

      const profileVersion = String(findDefault('trust.localProfileVersion') ?? 'v1').trim();
      if (profileVersion !== 'v1') {
        throw new Error('Unknown local profile version; refusing to edit settings.');
      }

      const loadedProjectScopeMode = String(findDefault('trust.projectScopeMode') ?? 'off').trim() as ProjectScopeMode;
      if (!LOCAL_PROJECT_SCOPE_MODES.includes(loadedProjectScopeMode)) {
        throw new Error(`Unknown persisted project scope mode: ${loadedProjectScopeMode || '(empty)'}`);
      }

      const loaded: LocalPolicySettings = {
        profile: loadedProfile,
        profileVersion: 'v1',
        autoApprove: Boolean(findDefault('trust.localAutoApprove')),
        projectScopeMode: loadedProjectScopeMode,
      };

      setPolicySettings(loaded);
      setPolicyForm(loaded);
    } catch (err) {
      setPolicyLoadError((err as Error).message || 'Failed to load policy settings');
      setPolicySettings(null);
    } finally {
      setPolicyLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (showSettingsDrawer) {
      void loadLocalPolicySettings();
    }
  }, [showSettingsDrawer, loadLocalPolicySettings]);

  // Fetch feature flags when unlocked
  useEffect(() => {
    if (pageState !== 'unlocked') return;
    api.get<Record<string, boolean>>(Api.Wallet, '/flags')
      .then((flags) => {
        setExperimentalWalletEnabled(Boolean(flags.EXPERIMENTAL_WALLET));
        setSocialEnabled(Boolean(flags.SOCIAL));
        setShowDiscoverHub(Boolean(flags.SHOW_DISCOVER_HUB));
      })
      .catch(() => {});
  }, [pageState]);

  useEffect(() => {
    const allowedViews = new Set<string>(['main']);
    if (experimentalWalletEnabled) {
      allowedViews.add('agents');
      if (socialEnabled) {
        allowedViews.add('social');
        if (showDiscoverHub) {
          allowedViews.add('hub');
        }
      }
    }

    if (allowedViews.has(activeViewId)) return;

    const fallbackViewId = 'main';
    setActiveViewId(fallbackViewId);
    localStorage.setItem('aura:activeViewId', fallbackViewId);
  }, [activeViewId, experimentalWalletEnabled, socialEnabled, showDiscoverHub]);

  // Fetch version
  useEffect(() => {
    fetch('/api/version', { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : null)
      .then((data: { success?: boolean; current?: string } | null) => {
        if (data?.success && typeof data.current === 'string' && data.current.trim()) {
          setInstalledVersion(data.current.trim());
        }
      })
      .catch(() => {});
  }, []);

  const persistLocalPolicySettings = useCallback(async () => {
    if (!token) throw new Error('Missing auth token for save.');
    if (!LOCAL_POLICY_PROFILES.includes(policyForm.profile)) {
      throw new Error('Unknown profile selected; refusing to persist.');
    }
    if (!LOCAL_PROJECT_SCOPE_MODES.includes(policyForm.projectScopeMode)) {
      throw new Error('Unknown project scope mode selected; refusing to persist.');
    }

    const baseUrl = api.getBaseUrl(Api.Wallet);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    const updates: Array<[string, unknown]> = [
      ['trust.localProfile', policyForm.profile],
      ['trust.localProfileVersion', 'v1'],
      ['trust.localAutoApprove', policyForm.autoApprove],
      ['trust.projectScopeMode', policyForm.projectScopeMode],
    ];

    const results = await Promise.all(
      updates.map(async ([key, value]) => {
        const response = await fetch(`${baseUrl}/defaults/${key}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ value }),
        });
        return response.ok;
      })
    );

    if (!results.every(Boolean)) {
      throw new Error('Failed to save canonical trust policy defaults.');
    }

    return { ...policyForm, profileVersion: 'v1' } as LocalPolicySettings;
  }, [policyForm, token]);

  const handleSaveLocalPolicy = useCallback(async () => {
    if (!policySettings || policyLoading || policySaving) return;
    const enablingDangerous = !isDangerousPolicySelection(policySettings) && isDangerousPolicySelection(policyForm);
    if (enablingDangerous && !dangerConfirmOpen) {
      setDangerConfirmOpen(true);
      return;
    }

    setPolicySaving(true);
    setPolicySaveError(null);
    setPolicySaveSuccess(null);
    try {
      const saved = await persistLocalPolicySettings();
      setPolicySettings(saved);
      setPolicyForm(saved);
      setDangerConfirmOpen(false);
      setPolicySaveSuccess('Local trust policy saved. Make sure you restart AuraMaxx to apply the new policy. Changes apply to newly issued local tokens only.');
    } catch (err) {
      const message = (err as Error).message || 'Failed to save policy settings';
      setDangerConfirmOpen(false);
      if (
        message.includes('Unknown profile selected')
        || message.includes('Unknown project scope mode selected')
      ) {
        setPolicySaveError(message);
      } else {
        await loadLocalPolicySettings();
        setPolicySaveError(`${message} Server values were reloaded.`);
      }
    } finally {
      setPolicySaving(false);
    }
  }, [dangerConfirmOpen, isDangerousPolicySelection, loadLocalPolicySettings, persistLocalPolicySettings, policyForm, policyLoading, policySaving, policySettings]);

  const closePasswordModal = useCallback(() => {
    setShowPasswordModal(false);
    setCurrentPasswordValue('');
    setNewPasswordValue('');
    setConfirmPasswordValue('');
    setPasswordChangeError(null);
    setPasswordChanging(false);
  }, []);

  const handleChangePrimaryPassword = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordChangeError(null);
    setPasswordChangeSuccess(null);

    if (newPasswordValue.length < 8) {
      setPasswordChangeError('New password must be at least 8 characters.');
      return;
    }
    if (newPasswordValue !== confirmPasswordValue) {
      setPasswordChangeError('New password and confirmation do not match.');
      return;
    }

    setPasswordChanging(true);
    try {
      await changePrimaryAgentPassword(currentPasswordValue, newPasswordValue);
      setPasswordChangeSuccess('Primary agent password updated.');
      closePasswordModal();
    } catch (err) {
      setPasswordChangeError((err as Error).message || 'Failed to change primary password.');
    } finally {
      setPasswordChanging(false);
    }
  }, [closePasswordModal, confirmPasswordValue, currentPasswordValue, newPasswordValue]);

  const handleRecoveryWordChange = useCallback((index: number, value: string) => {
    const normalized = value.trim().toLowerCase();

    if (normalized.includes(' ')) {
      const parsed = normalizeRecoveryWords(normalized);
      if (parsed.length > 1) {
        const nextWords = [...recoveryWords];
        parsed.forEach((word, offset) => {
          const targetIndex = index + offset;
          if (targetIndex < nextWords.length) nextWords[targetIndex] = word;
        });
        setRecoveryWords(nextWords);
        setRecoveryError(null);
        return;
      }
    }

    const nextWords = [...recoveryWords];
    nextWords[index] = normalized;
    setRecoveryWords(nextWords);
    setRecoveryError(null);
  }, [recoveryWords]);

  const handleRecoveryPaste = useCallback((index: number, text: string) => {
    const parsed = normalizeRecoveryWords(text);
    if (parsed.length <= 1) return false;

    const nextWordCount: 12 | 24 = parsed.length > 12 ? 24 : recoveryWordCount;
    if (nextWordCount !== recoveryWordCount) {
      setRecoveryWordCount(nextWordCount);
      const nextWords = Array(nextWordCount).fill('');
      parsed.slice(0, nextWordCount).forEach((word, wordIndex) => {
        nextWords[wordIndex] = word;
      });
      setRecoveryWords(nextWords);
      setRecoveryError(null);
      return true;
    }

    const nextWords = [...recoveryWords];
    parsed.forEach((word, offset) => {
      const targetIndex = index + offset;
      if (targetIndex < nextWords.length) nextWords[targetIndex] = word;
    });
    setRecoveryWords(nextWords);
    setRecoveryError(null);
    return true;
  }, [recoveryWordCount, recoveryWords]);

  const handleRecoverAccess = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setRecoveryError(null);

    if (recoveryNewPassword.length < 8) {
      setRecoveryError('New password must be at least 8 characters.');
      return;
    }
    if (!isRecoveryPhraseStructurallyValid) {
      setRecoveryError('Enter a valid 12 or 24-word BIP-39 seed phrase.');
      return;
    }

    setRecoveryLoading(true);
    try {
      const { publicKeyBase64 } = await generateAgentKeypair();
      const result = await recoverWalletAccess(normalizedRecoveryPhrase, recoveryNewPassword, publicKeyBase64);
      if (result.token) {
        setToken(result.token, { persist: trustDevice ? 'local' : 'session' });
      }
      setPassword('');
      setRecoveryNewPassword('');
      setRecoveryWords(Array(recoveryWordCount).fill(''));
      // Route through transition state to avoid jarring layout shift
      beginTransitionState();
      void bootstrapDashboardTransition();
    } catch (err) {
      setRecoveryError((err as Error).message || 'Recovery failed.');
    } finally {
      setRecoveryLoading(false);
    }
  }, [beginTransitionState, isRecoveryPhraseStructurallyValid, normalizedRecoveryPhrase, recoveryNewPassword, recoveryWordCount, setToken, trustDevice]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;

    setLoading(true);
    setError(null);
    try {
      // Generate keypair before unlock so the token is minted with our pubkey
      const { publicKeyBase64 } = await generateAgentKeypair();
      const data = await unlockWallet(password, undefined, publicKeyBase64);
      if (data.token) {
        setToken(data.token, { persist: trustDevice ? 'local' : 'session' });
      }
      setPassword('');
      // Route through transition state to avoid jarring layout shift
      beginTransitionState();
      void bootstrapDashboardTransition();
    } catch (err) {
      setError((err as Error).message || 'Unlock failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return;

    setLoading(true);
    setError(null);
    try {
      // Generate keypair before setup so the initial token has our pubkey
      const { publicKeyBase64 } = await generateAgentKeypair();
      const result = await setupWallet(password, publicKeyBase64);
      if (result.token) {
        setToken(result.token, { persist: trustDevice ? 'local' : 'session' });
        setOnboardingToken(result.token);
      }
      if (result.mnemonic) {
        setMnemonic(result.mnemonic);
        setSeedAcknowledged(false);
        setSetupOnboardingStep('seed');
        setSeedRecoveryNotice(null);
        setSeedPhraseActionStatus(null);
      }
      setPassword('');
      if (!result.mnemonic) fetchState();
    } catch (err) {
      const message = (err as Error).message || 'Setup failed';
      if (/already exists/i.test(message)) {
        setError('Primary agent already exists. Enter your password to unlock it.');
        setPageState('locked');
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleCopySeedPhrase = useCallback(async () => {
    if (!mnemonic) return;

    let copied = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(mnemonic);
        copied = true;
      } catch {
        copied = false;
      }
    }

    if (copied) {
      setSeedPhraseActionStatus('copied');
      return;
    }

    const fallbackTextarea = document.createElement('textarea');
    fallbackTextarea.value = mnemonic;
    fallbackTextarea.setAttribute('readonly', 'true');
    fallbackTextarea.style.position = 'fixed';
    fallbackTextarea.style.left = '-9999px';
    document.body.appendChild(fallbackTextarea);
    fallbackTextarea.focus();
    fallbackTextarea.select();

    let fallbackCopied = false;
    try {
      fallbackCopied = document.execCommand('copy');
    } catch {
      fallbackCopied = false;
    } finally {
      fallbackTextarea.remove();
    }

    setSeedPhraseActionStatus(fallbackCopied ? 'copied' : 'copy-failed');
  }, [mnemonic]);

  const handleDownloadSeedBackup = useCallback(() => {
    if (!mnemonic) return;

    const dateStamp = new Date().toISOString().slice(0, 10);
    const numberedWords = mnemonic
      .split(' ')
      .map((word, index) => `${index + 1}. ${word}`)
      .join('\n');
    const markdown = `# Aura Agent Seed Phrase Backup\n\n**Date:** ${dateStamp}\n**WARNING:** Keep this file safe and private. Anyone with this phrase can access your agent.\n\n${numberedWords}\n`;
    const filename = `aura-seed-backup-${dateStamp}.md`;

    let objectUrl = '';
    const downloadLink = document.createElement('a');
    try {
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      objectUrl = URL.createObjectURL(blob);
      downloadLink.href = objectUrl;
      downloadLink.download = filename;
      downloadLink.style.display = 'none';
      document.body.appendChild(downloadLink);
      downloadLink.click();
      setSeedPhraseActionStatus('downloaded');
    } catch {
      setSeedPhraseActionStatus('download-failed');
    } finally {
      downloadLink.remove();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    }
  }, [mnemonic]);

  const persistLocalAgentMode = useCallback(async () => {
    const authToken = onboardingToken || token;
    if (!authToken) {
      throw new Error('Session token unavailable. Unlock again and retry setup.');
    }

    const profile = localAgentMode;
    const profileVersion = 'v1';
    const autoApprove = profile !== 'strict';
    const baseUrl = api.getBaseUrl(Api.Wallet);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    };

    await fetch(`${baseUrl}/defaults/trust.localProfile`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: profile }),
    });
    await fetch(`${baseUrl}/defaults/trust.localProfileVersion`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: profileVersion }),
    });
    await fetch(`${baseUrl}/defaults/trust.localAutoApprove`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: autoApprove }),
    });
  }, [localAgentMode, onboardingToken, token]);

  const bootstrapDashboardTransition = useCallback(async () => {
    setDashboardTransitionTimedOut(false);
    let finished = false;
    const timeout = window.setTimeout(() => {
      if (!finished) setDashboardTransitionTimedOut(true);
    }, DASHBOARD_TRANSITION_TIMEOUT_MS);

    try {
      await fetchState();
      finished = true;
    } finally {
      window.clearTimeout(timeout);
    }
  }, [fetchState]);

  const handlePasskeyUnlock = useCallback(async () => {
    setPasskeyLoading(true);
    setError(null);
    try {
      const { publicKeyBase64 } = await generateAgentKeypair();

      const options = await api.post<{
        challenge: string;
        rpId: string;
        allowCredentials: Array<{ id: string; transports?: string[] }>;
        timeout: number;
        userVerification: string;
      }>(Api.Wallet, '/auth/passkey/authenticate/options', {});

      const toBuffer = (b: string): ArrayBuffer => {
        let s = b.replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        const bin = atob(s);
        const a = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        return a.buffer;
      };
      const toBase64url = (b: ArrayBuffer): string => {
        const bytes = new Uint8Array(b);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      };

      const publicKey: PublicKeyCredentialRequestOptions = {
        challenge: toBuffer(options.challenge),
        rpId: options.rpId,
        allowCredentials: (options.allowCredentials || []).map((c) => ({
          type: 'public-key' as const,
          id: toBuffer(c.id),
          transports: c.transports as AuthenticatorTransport[] | undefined,
        })),
        timeout: options.timeout,
        userVerification: (options.userVerification || 'required') as UserVerificationRequirement,
      };

      const credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null;
      if (!credential) {
        setPasskeyLoading(false);
        return;
      }

      const response = credential.response as AuthenticatorAssertionResponse;

      const result = await api.post<{ success: boolean; token?: string; error?: string }>(
        Api.Wallet,
        '/auth/passkey/authenticate/verify',
        {
          credential: {
            id: toBase64url(credential.rawId),
            rawId: toBase64url(credential.rawId),
            type: credential.type,
            response: {
              clientDataJSON: toBase64url(response.clientDataJSON),
              authenticatorData: toBase64url(response.authenticatorData),
              signature: toBase64url(response.signature),
              userHandle: response.userHandle ? toBase64url(response.userHandle) : undefined,
            },
          },
          pubkey: publicKeyBase64,
        },
      );

      if (result.success && result.token) {
        setToken(result.token, { persist: trustDevice ? 'local' : 'session' });
        beginTransitionState();
        void bootstrapDashboardTransition();
      } else {
        setError(result.error || 'Biometric authentication failed');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setPasskeyLoading(false);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Biometric authentication failed';
      if (msg.includes('agent_locked')) {
        // Agent was locked between probe and attempt — just hide the button
        setPasskeyAvailable(false);
      } else {
        setError(msg);
      }
    } finally {
      setPasskeyLoading(false);
    }
  }, [beginTransitionState, trustDevice, setToken, bootstrapDashboardTransition]);

  const handleFinalizeOnboarding = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await persistLocalAgentMode();
      setMnemonic(null);
      setSeedAcknowledged(false);
      setSeedRecoveryNotice(null);
      setOnboardingToken(null);
      setSetupOnboardingStep('seed');
      beginTransitionState();
      void bootstrapDashboardTransition();
    } catch (err) {
      setError((err as Error).message || 'Failed to save local agent mode');
    } finally {
      setLoading(false);
    }
  }, [beginTransitionState, bootstrapDashboardTransition, persistLocalAgentMode]);

  // CredentialAgent already calls POST /lock and clearToken() before invoking onLock.
  // This handler only needs to transition the page state.
  const handleLock = useCallback(() => {
    if (loaderExitTimerRef.current) {
      clearTimeout(loaderExitTimerRef.current);
      loaderExitTimerRef.current = null;
    }
    setLoaderExiting(false);
    setError(null);
    setPageState('locked');
  }, []);

  const handleNuke = useCallback(async () => {
    setNuking(true);
    setNukeError(null);
    try {
      await api.post(Api.Wallet, '/nuke', {});
      setShowSettingsDrawer(false);
      setDangerConfirmOpen(false);
      setPolicySaveError(null);
      setPolicyFormErrors({});
      setPasswordChangeError(null);
      setAgentThemeOpen(true);
      setAgentSettingsOpen(false);
      setSecuritySettingsOpen(false);
      setDangerZoneOpen(false);
      setShowPasswordModal(false);
      setNukeConfirmOpen(false);
      setNuking(false);
      setNukeError(null);
      if (policySettings) setPolicyForm(policySettings);
      window.location.reload();
    } catch (err) {
      setNukeError((err as Error).message || 'Failed to nuke wallet');
      console.error('[UnlockPage] Nuke failed:', err);
    } finally {
      setNuking(false);
    }
  }, [policySettings]);

  // --- Backup / Export handlers ---

  const fetchBackups = useCallback(async () => {
    if (!token) { setBackups([]); return; }
    setBackupsLoading(true);
    try {
      const data = await api.get<{ success: boolean; backups: Array<{ filename: string; timestamp: string; size: number; date: string }> }>(Api.Wallet, '/backup');
      if (data.success) setBackups(data.backups);
    } catch { setBackups([]); }
    finally { setBackupsLoading(false); }
  }, [token]);

  const handleCreateBackup = useCallback(async () => {
    setCreatingBackup(true);
    try {
      const data = await api.post<{ success: boolean; error?: string }>(Api.Wallet, '/backup');
      if (data.success) await fetchBackups();
    } catch (err) { console.error('Backup create failed', err); }
    finally { setCreatingBackup(false); }
  }, [fetchBackups]);

  const handleExportDb = useCallback(async () => {
    setExportingDb(true);
    try {
      const baseUrl = api.getBaseUrl(Api.Wallet);
      const res = await fetch(`${baseUrl}/backup/export`, {
        headers: { Authorization: `Bearer ${token || ''}` },
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : 'auramaxx-export.db';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) { console.error('Export failed', err); }
    finally { setExportingDb(false); }
  }, [token]);

  const handleRestoreBackup = useCallback(async (filename: string) => {
    setRestoringBackup(filename);
    try {
      const data = await api.put<{ success: boolean; error?: string }>(Api.Wallet, '/backup', { filename });
      if (data.success) window.location.reload();
    } catch (err) { console.error('Restore failed', err); }
    finally { setRestoringBackup(null); }
  }, []);

  const formatBackupDate = (ts: string) => {
    const y = ts.slice(0, 4), m = ts.slice(4, 6), d = ts.slice(6, 8), h = ts.slice(9, 11), min = ts.slice(11, 13);
    return `${y}-${m}-${d} ${h}:${min}`;
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const closeSettingsDrawer = useCallback(() => {
    if (policyFormDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    setShowSettingsDrawer(false);
    setDangerConfirmOpen(false);
    setPolicySaveError(null);
    setPolicyFormErrors({});
    setPasswordChangeError(null);
    setAgentThemeOpen(true);
    setAgentSettingsOpen(false);
    setSecuritySettingsOpen(false);
    setDangerZoneOpen(false);
    setBackupSectionOpen(false);
    setRestoreConfirmOpen(null);
    setRestoreAnchorEl(null);
    setShowPasswordModal(false);
    setNukeConfirmOpen(false);
    setNuking(false);
    setNukeError(null);
    if (policySettings) setPolicyForm(policySettings);
  }, [policyFormDirty, policySettings]);

  // Full-screen loader for initial state + unlock transition.
  // Keeps UI stable while agent status resolves.
  if (pageState === 'loading' || pageState === 'transition') {
    const statusLabel = pageState === 'transition' ? 'DECRYPTING AGENT' : 'CONNECTING';
    return (
      <div className="min-h-screen bg-[var(--color-background,#f4f4f5)] relative flex items-center justify-center p-4 overflow-hidden">
        <UpdateBanner />
        <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
          <div className="absolute inset-0 bg-grid-adaptive bg-[size:4rem_4rem] opacity-30" />
          <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />

          <div className="absolute bottom-[5%] right-[5%] opacity-5 select-none">
            <h1 className="text-[15vw] font-bold leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter text-right">
              AURAWALLET
            </h1>
          </div>
        </div>

        <div className="fixed top-6 left-6 z-50 flex items-center gap-3">
          <div className="w-10 h-10">
            <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
          </div>
        </div>

        <div className="fixed top-7 right-6 z-50 flex items-center gap-3 font-mono text-[10px] tracking-widest">
          <Link href="/docs" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">DOCS</Link>
          <Link href="/api" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">API</Link>
          <a href="https://github.com/Aura-Industry/aurawallet" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">GITHUB</a>
          <a href="https://x.com/npxauramaxx" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">X</a>
          <a href="https://x.com/nicoletteduclar" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">HELP</a>
          <DocsThemeToggle />
        </div>

        <div className={`relative z-10 w-full max-w-[320px] p-6 flex flex-col items-center text-center ${loaderExiting ? 'animate-fade-out-up' : 'animate-fade-in-up'}`}>
          <div className="w-10 h-10 mb-2 opacity-60">
            <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
          </div>
          <div className="w-6 h-6 border-2 border-[var(--color-border,#d4d4d8)] border-t-[var(--color-text,#0a0a0a)] animate-spin" />
          <div className="mt-4 label-specimen text-[var(--color-text-muted,#6b7280)] animate-pulse">
            {statusLabel}
          </div>
          <div className="mt-3 w-32 h-[2px] skeleton-mech" />
          {pageState === 'transition' && dashboardTransitionTimedOut && (
            <div className="mt-6 w-full max-w-[280px] space-y-3 text-center">
              <div className="text-[9px] text-[var(--color-danger,#ef4444)] bg-[var(--color-danger,#ef4444)]/10 px-3 py-2 border border-[var(--color-danger,#ef4444)]/20">
                Dashboard took too long. You can retry without re-running onboarding.
              </div>
              <button
                onClick={() => { void bootstrapDashboardTransition(); }}
                className="w-full py-2.5 bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] font-mono text-xs tracking-widest font-bold hover:opacity-90 transition-opacity clip-specimen-sm"
              >
                RETRY
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Unlocked: render full-screen agent + root settings drawer controls
  if (pageState === 'unlocked') {
    const baseViews = experimentalWalletEnabled
      ? DEFAULT_VIEWS
      : DEFAULT_VIEWS.filter((view) => view.id === 'main');
    const views = [
      ...baseViews,
      ...(experimentalWalletEnabled && socialEnabled ? [SOCIAL_VIEW, ...(showDiscoverHub ? [HUB_VIEW] : [])] : []),
    ];
    return (
      <div className="relative h-screen flex agent-surface overflow-hidden">
        <LeftRail
          views={views}
          activeViewId={activeViewId}
          onSelectView={handleSelectView}
          hubs={hubs}
          activeHubUrl={activeHubUrl}
          onSelectHub={handleSelectHub}
          favoriteHubUrls={favoriteHubUrls}
          nonRemovableHubUrls={defaultHubUrl ? [defaultHubUrl] : []}
          onToggleHubFavorite={handleToggleFavoriteHub}
          onRemoveHub={handleRemoveHub}
          onAddHub={experimentalWalletEnabled && showDiscoverHub ? () => {
            setAddHubError(null);
            setShowAddHub(true);
          } : undefined}
        />
        <div className="relative flex-1 h-full overflow-hidden">
        <UpdateBanner />
        {/* Top-right icon bar: Help, Settings, Notifications, Dark mode */}
        <div className="fixed top-3 right-6 z-50 flex items-center gap-1.5">
          <a
            href="https://x.com/nicoletteduclar"
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-surface,#ffffff)]/50 transition-colors rounded"
            title="Help"
            aria-label="Help"
          >
            <CircleHelp size={14} />
          </a>
          <button
            onClick={() => setShowSettingsDrawer(true)}
            className="p-1.5 text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-surface,#ffffff)]/50 transition-colors rounded"
            title="Settings"
            aria-label="Settings"
          >
            <Settings size={14} />
          </button>
          <NotificationDrawer
            notifications={pageNotifications}
            onDismiss={pageDismissNotification}
          />
          <DocsThemeToggle />
        </div>

        {/* Bottom-right links: Docs, API, GitHub, X, Help */}
        <div
          className="fixed right-6 z-50 flex items-center gap-3 font-mono text-[10px] tracking-widest transition-[bottom]"
          style={{ bottom: utilityLinksBottomOffset }}
        >
          <Link href="/docs" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">DOCS</Link>
          <Link href="/api" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">API</Link>
          <a href="https://github.com/Aura-Industry/aurawallet" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">GITHUB</a>
          <a href="https://x.com/npxauramaxx" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">X</a>
          <a href="https://x.com/nicoletteduclar" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">HELP</a>
        </div>

        <div className={activeViewId === 'main' ? 'h-full' : 'hidden'}>
          {socialEnabled ? (
            <PrimaryHubRegistrationGate>
              <CredentialAgent
                onLock={handleLock}
                onSettings={() => setShowSettingsDrawer(true)}
              />
            </PrimaryHubRegistrationGate>
          ) : (
            <CredentialAgent
              onLock={handleLock}
              onSettings={() => setShowSettingsDrawer(true)}
            />
          )}
        </div>
        {experimentalWalletEnabled && (
          <div className={activeViewId === 'agents' ? 'h-full' : 'hidden'}>
            <VerificationView />
          </div>
        )}
        {experimentalWalletEnabled && socialEnabled && (
          <div className={activeViewId === 'social' ? 'h-full' : 'hidden'}>
            <PrimaryHubRegistrationGate>
              <SocialView activeHubUrl={activeHubUrl || undefined} />
            </PrimaryHubRegistrationGate>
          </div>
        )}
        {experimentalWalletEnabled && socialEnabled && showDiscoverHub && (
          <div className={activeViewId === 'hub' ? 'h-full' : 'hidden'}>
            <HubView
              hub={hubs.find(h => h.hubUrl === activeHubUrl)}
              hasHubs={hubs.length > 0}
              onAddHub={() => { setAddHubError(null); setShowAddHub(true); }}
            />
          </div>
        )}

        <SettingsDrawer
          isOpen={showSettingsDrawer}
          onClose={closeSettingsDrawer}
          passwordChangeSuccess={passwordChangeSuccess}
          agentThemeOpen={agentThemeOpen}
          onToggleAgentTheme={() => setAgentThemeOpen((open) => !open)}
          colorMode={colorMode}
          uiScale={uiScale}
          onColorModeChange={setColorMode}
          onUiScaleChange={setUiScale}
          agentColorModeOptions={AGENT_COLOR_MODE_OPTIONS}
          agentUiScaleOptions={AGENT_UI_SCALE_OPTIONS}
          agentSettingsOpen={agentSettingsOpen}
          onToggleAgentSettings={() => setAgentSettingsOpen((open) => !open)}
          policyLoadError={policyLoadError}
          policyLoading={policyLoading}
          onRetryLoadPolicy={() => { void loadLocalPolicySettings(); }}
          policyForm={policyForm}
          onPolicyAutoApproveChange={(checked) => setPolicyForm((prev) => ({ ...prev, autoApprove: checked }))}
          localProfileOptions={LOCAL_PROFILE_ITEM_OPTIONS}
          onPolicyProfileChange={(value) => setPolicyForm((prev) => ({ ...prev, profile: value }))}
          localProjectScopeOptions={LOCAL_PROJECT_SCOPE_ITEM_OPTIONS}
          onPolicyProjectScopeModeChange={(value) => setPolicyForm((prev) => ({ ...prev, projectScopeMode: value }))}
          dangerConfirmOpen={dangerConfirmOpen}
          onCancelDangerConfirm={() => {
            setDangerConfirmOpen(false);
            if (policySettings) setPolicyForm(policySettings);
          }}
          onConfirmDangerousSave={() => { void handleSaveLocalPolicy(); }}
          policySaving={policySaving}
          policySaveError={policySaveError}
          policySaveSuccess={policySaveSuccess}
          canSavePolicy={!Boolean(policyLoadError) && !policyLoading && !policySaving && Boolean(policySettings)}
          onSavePolicy={() => { void handleSaveLocalPolicy(); }}
          securitySettingsOpen={securitySettingsOpen}
          onToggleSecuritySettings={() => setSecuritySettingsOpen((open) => !open)}
          passwordChangeError={passwordChangeError}
          onOpenPasswordModal={() => {
            setPasswordChangeError(null);
            setShowPasswordModal(true);
          }}
          backupSectionOpen={backupSectionOpen}
          onToggleBackupSection={() => {
            const next = !backupSectionOpen;
            setBackupSectionOpen(next);
            if (next) void fetchBackups();
          }}
          creatingBackup={creatingBackup}
          onCreateBackup={() => { void handleCreateBackup(); }}
          exportingDb={exportingDb}
          onExportDb={() => { void handleExportDb(); }}
          backupsLoading={backupsLoading}
          backups={backups}
          formatBackupDate={formatBackupDate}
          formatSize={formatSize}
          restoreConfirmOpen={restoreConfirmOpen}
          onOpenRestoreConfirm={(filename, anchorEl) => {
            setRestoreAnchorEl(anchorEl);
            setRestoreConfirmOpen(filename);
          }}
          onCloseRestoreConfirm={() => {
            setRestoreConfirmOpen(null);
            setRestoreAnchorEl(null);
          }}
          onConfirmRestore={(filename) => {
            setRestoreConfirmOpen(null);
            setRestoreAnchorEl(null);
            void handleRestoreBackup(filename);
          }}
          restoringBackup={restoringBackup}
          dangerZoneOpen={dangerZoneOpen}
          onToggleDangerZone={() => setDangerZoneOpen((open) => !open)}
          nukeError={nukeError}
          onOpenNukeConfirm={() => {
            setNukeError(null);
            setNukeConfirmOpen(true);
          }}
          nuking={nuking}
        />

        <ConfirmationModal
          isOpen={nukeConfirmOpen}
          onClose={() => setNukeConfirmOpen(false)}
          onConfirm={() => { void handleNuke(); }}
          title="Nuke Agent"
          message="Permanently delete your agent, wallets, credentials, and local configuration. This cannot be undone."
          confirmText="NUKE"
          cancelText="CANCEL"
          variant="danger"
          loading={nuking}
        />

        <ConfirmationModal
          isOpen={discardConfirmOpen}
          onClose={() => setDiscardConfirmOpen(false)}
          onConfirm={() => {
            setDiscardConfirmOpen(false);
            setShowSettingsDrawer(false);
            setDangerConfirmOpen(false);
            setPolicySaveError(null);
            setPolicyFormErrors({});
            setPasswordChangeError(null);
            setAgentThemeOpen(true);
            setAgentSettingsOpen(false);
            setSecuritySettingsOpen(false);
            setDangerZoneOpen(false);
            setBackupSectionOpen(false);
            setRestoreConfirmOpen(null);
            setRestoreAnchorEl(null);
            setShowPasswordModal(false);
            setNukeConfirmOpen(false);
            setNuking(false);
            setNukeError(null);
            if (policySettings) setPolicyForm(policySettings);
          }}
          variant="warning"
          title="Discard Changes"
          message="You have unsaved local policy changes. Discard them?"
          confirmText="DISCARD"
          cancelText="KEEP EDITING"
        />

        <Modal
          isOpen={showPasswordModal}
          onClose={closePasswordModal}
          title="Change Primary Password"
          subtitle="Security"
          size="sm"
        >
          <form onSubmit={handleChangePrimaryPassword} className="space-y-3">
            <TextInput
              type="password"
              label="CURRENT PASSWORD"
              aria-label="CURRENT PASSWORD"
              value={currentPasswordValue}
              onChange={(e) => setCurrentPasswordValue(e.target.value)}
              autoFocus
              compact
            />
            <TextInput
              type="password"
              label="NEW PASSWORD"
              aria-label="NEW PASSWORD"
              value={newPasswordValue}
              onChange={(e) => setNewPasswordValue(e.target.value)}
              compact
            />
            <TextInput
              type="password"
              label="CONFIRM NEW PASSWORD"
              aria-label="CONFIRM NEW PASSWORD"
              value={confirmPasswordValue}
              onChange={(e) => setConfirmPasswordValue(e.target.value)}
              compact
            />
            {passwordChangeError && <div className="text-[10px] text-[var(--color-danger)]">{passwordChangeError}</div>}
            <div className="flex gap-2 pt-2">
              <Button
                type="button"
                onClick={closePasswordModal}
                disabled={passwordChanging}
                variant="secondary"
                size="lg"
                className="flex-1"
              >
                CANCEL
              </Button>
              <Button
                type="submit"
                disabled={passwordChanging || !currentPasswordValue || !newPasswordValue || !confirmPasswordValue}
                variant="primary"
                size="lg"
                className="flex-1"
              >
                {passwordChanging ? 'UPDATING...' : 'UPDATE PASSWORD'}
              </Button>
            </div>
          </form>
        </Modal>

        {/* Add Server (Hub) Modal */}
        <Modal
          isOpen={showAddHub}
          onClose={() => { setShowAddHub(false); setAddHubError(null); }}
          title="Add Server"
          subtitle="Hubs"
          size="sm"
        >
          <div className="space-y-3">
            <TextInput
              label="HUB URL"
              aria-label="HUB URL"
              placeholder="https://hub.example.com"
              value={addHubUrl}
              onChange={(e) => setAddHubUrl(e.target.value)}
              autoFocus
              compact
            />
            <TextInput
              label="LABEL (OPTIONAL)"
              aria-label="LABEL"
              placeholder="My Server"
              value={addHubLabel}
              onChange={(e) => setAddHubLabel(e.target.value)}
              compact
            />
            {addHubError && <div className="text-[10px] text-[var(--color-danger)]">{addHubError}</div>}
            <div className="flex gap-2 pt-2">
              <Button
                type="button"
                onClick={() => { setShowAddHub(false); setAddHubError(null); }}
                disabled={addHubLoading}
                variant="secondary"
                size="lg"
                className="flex-1"
              >
                CANCEL
              </Button>
              <Button
                type="button"
                onClick={handleJoinHub}
                disabled={addHubLoading || !addHubUrl.trim()}
                variant="primary"
                size="lg"
                className="flex-1"
              >
                {addHubLoading ? 'JOINING...' : 'JOIN'}
              </Button>
            </div>
          </div>
        </Modal>

        <Modal
          isOpen={Boolean(hubActionError)}
          onClose={() => setHubActionError(null)}
          title="Hub Action Failed"
          subtitle="Hubs"
          size="sm"
        >
          <div className="space-y-3">
            <p className="text-[11px] text-[var(--color-text-muted,#6b7280)] font-mono">
              {hubActionError}
            </p>
            <div className="flex justify-end pt-1">
              <Button
                type="button"
                onClick={() => setHubActionError(null)}
                variant="primary"
                size="lg"
              >
                OK
              </Button>
            </div>
          </div>
        </Modal>

        <PasskeyEnrollmentPrompt isUnlocked={pageState === 'unlocked'} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-background,#f4f4f5)] relative flex items-center justify-center p-4">
      <UpdateBanner />
      {/* Background — sterile field (same as docs/api) */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute inset-0 bg-grid-adaptive bg-[size:4rem_4rem] opacity-30" />
        <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />

        {/* Giant background typography */}
        <div className="absolute bottom-[5%] right-[5%] opacity-5 select-none" data-testid="home-background-branding">
          <h1 className="text-[15vw] font-bold leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter text-right">
            AURAWALLET
          </h1>
        </div>

        {/* Corner finder patterns */}
        <div className="absolute top-10 left-10 w-32 h-32 border-l-4 border-t-4 border-[var(--color-text,#0a0a0a)] opacity-10">
          <div className="absolute top-2 left-2 w-4 h-4 bg-[var(--color-text,#0a0a0a)]" />
        </div>
        <div className="absolute bottom-10 right-10 w-32 h-32 border-r-4 border-b-4 border-[var(--color-text,#0a0a0a)] opacity-10 flex items-end justify-end">
          <div className="absolute bottom-2 right-2 w-4 h-4 bg-[var(--color-text,#0a0a0a)]" />
        </div>
      </div>

      {/* Logo header */}
      <div className="fixed top-6 left-6 z-50 flex items-center gap-3">
        <div className="w-10 h-10">
          <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
        </div>
      </div>

      {/* Nav */}
      <div className="fixed top-7 right-6 z-50 flex items-center gap-3 font-mono text-[10px] tracking-widest">
        <Link href="/docs" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">DOCS</Link>
        <Link href="/api" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">API</Link>
        <a href="https://github.com/Aura-Industry/aurawallet" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">GITHUB</a>
        <a href="https://x.com/npxauramaxx" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">X</a>
        <a href="https://x.com/nicoletteduclar" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">HELP</a>
        <DocsThemeToggle />
      </div>

      {/* Unlock card */}
      <div className="relative z-10 w-full max-w-[380px]">
        {/* Vertical specimen label */}
        <div className="absolute -left-8 top-1/2 -translate-y-1/2 text-vertical label-specimen-sm text-[var(--color-text-faint,#9ca3af)] select-none hidden sm:block">
          AGENT&nbsp;ACCESS
        </div>
        <div className="bg-[var(--color-surface,#f4f4f2)] clip-specimen border-mech shadow-mech overflow-hidden font-mono corner-marks">
          {/* Card header bar */}
          <div className="px-5 py-3 border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] flex items-center justify-between">
            <span className="font-sans font-bold text-sm text-[var(--color-text,#0a0a0a)] uppercase tracking-tight">
              {pageState === 'setup' ? 'Initialize' : 'Unlock'}
            </span>
            <span className="text-[9px] text-[var(--color-text-faint,#9ca3af)] font-bold tracking-widest">
              {pageState === 'setup' ? 'NO_AGENT' : 'LOCKED'}
            </span>
          </div>

          <div className="p-6">
            {pageState === 'setup' && mnemonic && setupOnboardingStep === 'seed' && (
              <div className="flex flex-col items-center">
                <div className="w-16 h-16 mb-4">
                  <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
                </div>
                <div className="text-[10px] text-[var(--color-text-muted,#6b7280)] tracking-widest text-center mb-4">
                  SAVE YOUR RECOVERY PHRASE
                </div>
                <div className="text-[9px] text-[var(--color-danger,#ef4444)] bg-[var(--color-danger,#ef4444)]/10 px-3 py-2 border border-[var(--color-danger,#ef4444)]/20 mb-3">
                  Write this down and store it securely. You will stay on this screen until you explicitly confirm.
                </div>
                {seedRecoveryNotice && (
                  <div className="text-[9px] text-[var(--color-info,#0047ff)] bg-[var(--color-info,#0047ff)]/10 px-3 py-2 border border-[var(--color-info,#0047ff)]/20 mb-3">
                    {seedRecoveryNotice}
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2 w-full mb-4">
                  {mnemonic.split(' ').map((word, i) => (
                    <div key={i} className="text-[10px] font-mono text-[var(--color-text,#0a0a0a)] bg-[var(--color-background,#f4f4f5)] px-2 py-1 border border-[var(--color-border,#d4d4d8)]">
                      <span className="text-[var(--color-text-faint,#9ca3af)] mr-1">{i + 1}.</span>{word}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2 w-full mb-3">
                  <button
                    type="button"
                    onClick={() => { void handleCopySeedPhrase(); }}
                    className="h-9 px-2 border border-[var(--color-border,#d4d4d8)] font-mono text-[9px] tracking-widest text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-surface-alt,#fafafa)] transition-colors"
                  >
                    COPY SEED PHRASE
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadSeedBackup}
                    className="h-9 px-2 border border-[var(--color-border,#d4d4d8)] font-mono text-[9px] tracking-widest text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-surface-alt,#fafafa)] transition-colors"
                  >
                    DOWNLOAD BACKUP (.MD)
                  </button>
                </div>
                {seedPhraseActionStatus && (
                  <div
                    className="w-full mb-3 text-[9px] text-[var(--color-text-muted,#6b7280)]"
                    aria-live="polite"
                    data-testid="seed-phrase-action-status"
                  >
                    {seedPhraseActionStatus}
                  </div>
                )}
                <label className="flex items-start gap-2 w-full mb-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={seedAcknowledged}
                    onChange={(e) => setSeedAcknowledged(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-[9px] text-[var(--color-text-muted,#6b7280)]">
                    I have written and verified this recovery phrase in a secure location.
                  </span>
                </label>
                <button
                  onClick={() => {
                    if (!seedAcknowledged) return;
                    setSetupOnboardingStep('trust');
                  }}
                  disabled={!seedAcknowledged}
                  className="w-full py-2.5 bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] font-mono text-xs tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  CONTINUE TO AGENT MODE
                </button>
                <div className="w-full mt-3 text-[8px] text-[var(--color-text-faint,#9ca3af)] text-center">
                  If you leave before confirming, this phrase is recoverable only temporarily in this tab session. If recovery expires, restart onboarding to regenerate.
                </div>
              </div>
            )}

            {pageState === 'setup' && mnemonic && setupOnboardingStep === 'trust' && (
              <>
                <div className="flex flex-col items-center mb-6">
                  <div className="w-16 h-16 mb-4">
                    <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
                  </div>
                  <div className="text-[10px] text-[var(--color-text-muted,#6b7280)] tracking-widest text-center">
                    LOCAL AGENT MODE
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="text-[9px] text-[var(--color-text-muted,#6b7280)] bg-[var(--color-background,#f4f4f5)] px-3 py-2 border border-[var(--color-border,#d4d4d8)]">
                    How much do you trust your agent?
                  </div>

                  <fieldset className="border border-[var(--color-border,#d4d4d8)] p-2.5 bg-[var(--color-background,#f4f4f5)]">
                    <legend className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase px-1">
                      Pick a profile
                    </legend>
                    <ItemPicker
                      options={[...ONBOARDING_LOCAL_AGENT_MODE_OPTIONS]}
                      value={localAgentMode}
                      onChange={(value) => setLocalAgentMode(value as LocalAgentMode)}
                      ariaLabel="Onboarding local agent mode"
                    />
                  </fieldset>

                  {error && (
                    <div className="text-[9px] text-[var(--color-danger,#ef4444)] bg-[var(--color-danger,#ef4444)]/10 px-3 py-2 border border-[var(--color-danger,#ef4444)]/20">
                      {error}
                    </div>
                  )}

                  <button
                    onClick={() => { void handleFinalizeOnboarding(); }}
                    disabled={loading}
                    className="w-full py-2.5 bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] font-mono text-xs tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {loading ? (
                      <>
                        <div className="w-3 h-3 border border-[var(--color-surface,#ffffff)] border-t-transparent animate-spin" />
                        SAVING...
                      </>
                    ) : (
                      'SAVE MODE AND CONTINUE'
                    )}
                  </button>
                </div>
              </>
            )}

            {pageState === 'setup' && !mnemonic && (
              <>
                {/* Logo centered */}
                <div className="flex flex-col items-center mb-6">
                  <div className="w-16 h-16 mb-4">
                    <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
                  </div>
                  <div className="text-[10px] text-[var(--color-text-muted,#6b7280)] tracking-widest text-center">
                    CREATE YOUR ENCRYPTED AGENT
                  </div>
                  <div className="mt-2 text-[9px] text-[var(--color-text-faint,#9ca3af)] text-center leading-relaxed" data-testid="start-banner-quote">
                    {startBannerQuote}
                  </div>
                </div>

                <form onSubmit={handleSetup} className="space-y-4">
                  <div>
                    <label className="block text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest mb-1.5 uppercase">
                      Encryption Password
                    </label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); setError(null); }}
                      placeholder="Minimum 8 characters"
                      className="w-full px-3 py-2.5 border border-[var(--color-border,#d4d4d8)] font-mono text-sm text-[var(--color-text,#0a0a0a)] focus:outline-none focus:border-[var(--color-text,#0a0a0a)] bg-[var(--color-surface,#ffffff)] placeholder-[var(--color-text-faint,#9ca3af)] transition-colors"
                      autoFocus
                    />
                  </div>
                  <label className="flex items-center justify-between gap-3 text-[8px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
                    <span className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={trustDevice}
                        onChange={(e) => setTrustDevice(e.target.checked)}
                        className="h-3.5 w-3.5 border border-[var(--color-border,#d4d4d8)] accent-[var(--color-text,#0a0a0a)]"
                      />
                      Trusted device
                    </span>
                    <span>{trustDevice ? 'PERSISTENT' : 'TAB ONLY'}</span>
                  </label>

                  {error && (
                    <div className="text-[9px] text-[var(--color-danger,#ef4444)] bg-[var(--color-danger,#ef4444)]/10 px-3 py-2 border border-[var(--color-danger,#ef4444)]/20">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading || password.length < 8}
                    className="w-full py-2.5 bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] font-mono text-xs tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {loading ? (
                      <>
                        <div className="w-3 h-3 border border-[var(--color-surface,#ffffff)] border-t-transparent animate-spin" />
                        INITIALIZING...
                      </>
                    ) : (
                      'INITIALIZE AGENT'
                    )}
                  </button>
                </form>

                <div className="mt-4 pt-4 border-t border-[var(--color-border,#d4d4d8)]">
                  <div className="flex items-start gap-2">
                    <div className="w-1 h-1 bg-[var(--color-text-muted,#6b7280)] mt-1.5 flex-shrink-0" />
                    <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)] leading-relaxed">
                      This password encrypts your seed phrase locally. It never leaves your machine.
                    </span>
                  </div>
                </div>
              </>
            )}

            {pageState === 'locked' && (
              <>
                {/* Logo centered */}
                <div className="flex flex-col items-center mb-6">
                  <div className="w-16 h-16 mb-4">
                    <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
                  </div>
                  {/* Agent sprite carousel */}
                  <div className="w-full overflow-hidden">
                    <div className="yo-mobile-agent-marquee flex w-max items-end gap-1.5">
                      {marqueeSprites.map((sprite, index) => {
                        const baseIndex = index % UNLOCK_SPRITES.length;
                        const scatter = getSpriteScatterStyle(sprite.src, baseIndex, 0);
                        return (
                          <div key={`${sprite.src}-${index}`} style={scatter}>
                            <div
                              className="yo-sprite"
                              style={{
                                backgroundImage: `url('${sprite.src}')`,
                                animationDelay: `${baseIndex * -150}ms, ${baseIndex * -300}ms`,
                                width: sprite.width,
                                height: sprite.height,
                                marginBottom: sprite.baselineOffset,
                                backgroundPositionY: sprite.spriteY,
                                clipPath: `inset(0 0 ${sprite.cropBottom} 0)`,
                              } as CSSProperties}
                              role="img"
                              aria-label={`${sprite.label} sprite`}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="text-sm text-[var(--color-text-muted,#6b7280)] text-center font-mono mt-3" data-testid="start-banner-quote">
                    {startBannerQuote}
                  </div>
                </div>

                {!showSeedRecovery && (
                  <>
                    {passkeyAvailable && (
                      <div className="mb-4">
                        <button
                          type="button"
                          onClick={() => { void handlePasskeyUnlock(); }}
                          disabled={passkeyLoading}
                          className="w-full py-3 bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] font-mono text-xs tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                          {passkeyLoading ? (
                            <>
                              <div className="w-3 h-3 border border-[var(--color-surface,#ffffff)] border-t-transparent animate-spin" />
                              AUTHENTICATING...
                            </>
                          ) : (
                            <>
                              <Fingerprint size={14} />
                              UNLOCK WITH PASSKEY
                            </>
                          )}
                        </button>
                        <div className="mt-3 flex items-center gap-3">
                          <div className="flex-1 h-px bg-[var(--color-border,#d4d4d8)]" />
                          <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest">OR USE PASSWORD</span>
                          <div className="flex-1 h-px bg-[var(--color-border,#d4d4d8)]" />
                        </div>
                      </div>
                    )}
                    <form onSubmit={handleUnlock} className="space-y-4">
                      <div>
                        <label className="block text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest mb-1.5 uppercase">
                          Password
                        </label>
                        <input
                          type="password"
                          value={password}
                          onChange={(e) => { setPassword(e.target.value); setError(null); }}
                          placeholder="Enter agent password"
                          className="w-full px-3 py-2.5 border border-[var(--color-border,#d4d4d8)] font-mono text-sm text-[var(--color-text,#0a0a0a)] focus:outline-none focus:border-[var(--color-text,#0a0a0a)] bg-[var(--color-surface,#ffffff)] placeholder-[var(--color-text-faint,#9ca3af)] transition-colors"
                          autoFocus
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3 text-[8px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={trustDevice}
                            onChange={(e) => setTrustDevice(e.target.checked)}
                            className="h-3.5 w-3.5 border border-[var(--color-border,#d4d4d8)] accent-[var(--color-text,#0a0a0a)]"
                          />
                          Trust this device
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            setShowSeedRecovery(true);
                            setRecoveryError(null);
                          }}
                          className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors normal-case tracking-normal"
                        >
                          Forgot password?
                        </button>
                      </div>

                      {error && (
                        <div
                          data-testid="unlock-error-banner"
                          className="text-[9px] text-[var(--color-danger,#ef4444)] px-3 py-2 border"
                          style={{
                            borderColor: 'color-mix(in srgb, var(--color-danger,#ef4444) 35%, transparent)',
                            background: 'color-mix(in srgb, var(--color-danger,#ef4444) 12%, transparent)',
                          }}
                        >
                          {error}
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={loading || !password}
                        className="w-full py-2.5 bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] font-mono text-xs tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      >
                        {loading ? (
                          <>
                            <div className="w-3 h-3 border border-[var(--color-surface,#ffffff)] border-t-transparent animate-spin" />
                            UNLOCKING...
                          </>
                        ) : (
                          'UNLOCK'
                        )}
                      </button>
                    </form>
                  </>
                )}

                {showSeedRecovery && (
                  <div className="mt-4 border-t border-[var(--color-border,#d4d4d8)] pt-3 text-center">
                    <button
                      type="button"
                      onClick={() => {
                        setShowSeedRecovery(false);
                        setRecoveryError(null);
                      }}
                      className="text-[10px] underline underline-offset-2 text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
                    >
                      Back to unlock
                    </button>
                  </div>
                )}

                {showSeedRecovery && (
                  <form onSubmit={handleRecoverAccess} className="mt-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">Seed Recovery</div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => { setRecoveryWordCount(12); setRecoveryWords(Array(12).fill('')); }}
                          className={`px-2 py-1 text-[8px] border ${recoveryWordCount === 12 ? 'bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#fff)] border-[var(--color-text,#0a0a0a)]' : 'border-[var(--color-border,#d4d4d8)] text-[var(--color-text-muted,#6b7280)]'}`}
                        >12</button>
                        <button
                          type="button"
                          onClick={() => { setRecoveryWordCount(24); setRecoveryWords(Array(24).fill('')); }}
                          className={`px-2 py-1 text-[8px] border ${recoveryWordCount === 24 ? 'bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#fff)] border-[var(--color-text,#0a0a0a)]' : 'border-[var(--color-border,#d4d4d8)] text-[var(--color-text-muted,#6b7280)]'}`}
                        >24</button>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5">
                      {recoveryWords.map((word, index) => {
                        const invalid = invalidRecoveryIndexes.has(index);
                        return (
                          <TextInput
                            key={`recovery-word-${index}`}
                            compact
                            error={invalid}
                            aria-label={`Recovery word ${index + 1}`}
                            value={word}
                            onChange={(e) => handleRecoveryWordChange(index, e.target.value)}
                            onPaste={(e) => {
                              const didSplit = handleRecoveryPaste(index, e.clipboardData.getData('text'));
                              if (didSplit) e.preventDefault();
                            }}
                            placeholder={`${index + 1}`}
                            className="min-w-0"
                          />
                        );
                      })}
                    </div>

                    <div className="text-[9px] text-[var(--color-text-faint,#9ca3af)]">
                      {recoveryWordsFilled}/{recoveryWordCount} words · {invalidRecoveryIndexes.size > 0 ? `${invalidRecoveryIndexes.size} invalid word(s)` : (isRecoveryPhraseStructurallyValid ? 'BIP-39 phrase valid' : 'Waiting for valid BIP-39 phrase')}
                    </div>

                    <TextInput
                      type="password"
                      compact
                      value={recoveryNewPassword}
                      onChange={(e) => { setRecoveryNewPassword(e.target.value); setRecoveryError(null); }}
                      placeholder="New password"
                      aria-label="New password"
                    />
                    {recoveryError && (
                      <div className="text-[9px] text-[var(--color-danger,#ef4444)] bg-[var(--color-danger,#ef4444)]/10 px-3 py-2 border border-[var(--color-danger,#ef4444)]/20">
                        {recoveryError}
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={recoveryLoading}
                      className="w-full py-2.5 bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] font-mono text-xs tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-30"
                    >
                      {recoveryLoading ? 'RECOVERING...' : 'RECOVER & UNLOCK'}
                    </button>
                  </form>
                )}
              </>
            )}
          </div>

          {/* Barcode footer */}
          <div className="border-t border-[var(--color-border,#d4d4d8)] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <div className="h-4 flex-1 bg-[repeating-linear-gradient(90deg,var(--color-text,#000),var(--color-text,#000)_1px,transparent_1px,transparent_3px)] opacity-30" />
              <span className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase">aurawallet</span>
              <span className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest">
                {installedVersion !== 'unknown' ? `v${installedVersion.replace(/^v/i, '')}` : ''}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
