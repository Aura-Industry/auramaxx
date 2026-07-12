import { ComponentType, lazy } from 'react';
import type { AppColor } from '@/components/apps/DraggableApp';
import type { LucideIcon } from 'lucide-react';
import {
  Wallet,
  Key,
  ScrollText,
  Send,
  Globe,
  Box,
  Coins,
  Sparkles,
  ArrowUpDown,
} from 'lucide-react';

export interface AppDefinition {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>; // Allow any props since different apps have different needs
  icon: LucideIcon;
  color: AppColor;
  defaultSize: { width: number; height: number };
  title: string;
  resizable?: boolean;
  /** Set to true if this app needs special props from page.tsx instead of just config */
  requiresSpecialProps?: boolean;
  /**
   * Singleton apps can only have one instance per workspace.
   * Multi-instance apps (singleton: false) can be opened multiple times with different IDs.
   * Default: true for built-in apps, false for iframe/installed
   */
  singleton?: boolean;
  /** Short description for the app store */
  description?: string;
  /** Category for filtering in the app store */
  category?: string;
}

// Cache for dynamically-created app definitions (installed:)
// Without this, each call to getAppDefinition creates a new lazy() component,
// causing React to remount the app on every render (e.g., during drag).
const _definitionCache = new Map<string, AppDefinition>();

// Built-in app types
export const APP_TYPES: Record<string, AppDefinition> = {
  logs: {
    component: lazy(() => import('@/components/apps/LogsApp')),
    icon: ScrollText,
    color: 'gray',
    defaultSize: { width: 600, height: 300 },
    title: 'EVENT LOGS',
    singleton: true,
  },
  send: {
    component: lazy(() => import('@/components/apps/SendApp')),
    icon: Send,
    color: 'teal',
    defaultSize: { width: 320, height: 280 },
    title: 'SEND',
    singleton: true,
  },
  agentKeys: {
    component: lazy(() => import('@/components/apps/AgentKeysApp')),
    icon: Key,
    color: 'orange',
    defaultSize: { width: 340, height: 400 },
    title: 'AGENT KEYS',
    singleton: true,
  },
  token: {
    component: lazy(() => import('@/components/apps/TokenApp')),
    icon: Coins,
    color: 'lime',
    defaultSize: { width: 380, height: 480 },
    title: 'TOKEN',
    singleton: false,
    resizable: true,
    description: 'View token market data and price chart',
    category: 'info',
  },
  setup: {
    component: lazy(() => import('@/components/apps/SetupWizardApp')),
    icon: Sparkles,
    color: 'blue',
    defaultSize: { width: 420, height: 520 },
    title: 'GETTING STARTED',
    singleton: true,
  },
  transactions: {
    component: lazy(() => import('@/components/apps/TransactionsApp')),
    icon: ArrowUpDown,
    color: 'teal',
    defaultSize: { width: 520, height: 400 },
    title: 'TRANSACTIONS',
    singleton: true,
    resizable: true,
  },
  // Multi-instance app types (can open multiple with different IDs)
  walletDetail: {
    component: lazy(() => import('@/components/apps/WalletDetailApp')),
    icon: Wallet,
    color: 'orange',
    defaultSize: { width: 320, height: 380 },
    title: 'WALLET',
    resizable: true,
    requiresSpecialProps: true,
    singleton: false, // Can have multiple wallet detail apps open
  },
  iframe: {
    component: lazy(() => import('@/components/apps/IFrameApp')),
    icon: Globe,
    color: 'blue',
    defaultSize: { width: 400, height: 300 },
    title: 'IFRAME',
    resizable: true,
    singleton: false,
  },
};

/**
 * Get app definition by type
 * Supports:
 * - Built-in types: 'wallets', 'logs', 'send', etc.
 * - Installed (third-party) types: 'installed:app-id'
 */
export function getAppDefinition(appType: string): AppDefinition | null {
  // Check if it's a built-in type
  if (appType in APP_TYPES) {
    return APP_TYPES[appType];
  }

  // Check cache for installed: types
  if (_definitionCache.has(appType)) {
    return _definitionCache.get(appType)!;
  }

  // Check if it's an installed (third-party) app
  if (appType.startsWith('installed:')) {
    const appId = appType.slice(10); // Remove 'installed:' prefix
    const def: AppDefinition = {
      component: lazy(() => import('@/components/apps/ThirdPartyApp')),
      icon: Box,
      color: 'gray',
      defaultSize: { width: 320, height: 280 },
      title: appId.toUpperCase(),
      resizable: true,
      singleton: false,
      requiresSpecialProps: true,
      category: 'installed',
    };
    _definitionCache.set(appType, def);
    return def;
  }

  return null;
}

/**
 * Check if a app type is singleton (only one instance per workspace)
 */
export function isSingletonApp(appType: string): boolean {
  const def = getAppDefinition(appType);
  // Default to true for unknown types (safer)
  return def?.singleton ?? true;
}

/**
 * Get all registered app types
 */
export function getRegisteredAppTypes(): string[] {
  return Object.keys(APP_TYPES);
}

/**
 * Check if a app type exists
 */
export function isValidAppType(appType: string): boolean {
  return appType in APP_TYPES || appType.startsWith('installed:');
}
