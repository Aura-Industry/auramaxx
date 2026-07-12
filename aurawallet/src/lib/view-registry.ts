/**
 * View Registry — defines available views for the multi-view app shell.
 * Extensible: add new views by adding entries to DEFAULT_VIEWS or CREATABLE_VIEWS.
 */

export interface ViewDefinition {
  id: string;
  label: string;
  icon: string; // Lucide icon name
  description?: string;
  /** If true, this view is always present and cannot be removed */
  pinned?: boolean;
}

/** Views that are always shown in the left rail */
export const DEFAULT_VIEWS: ViewDefinition[] = [
  {
    id: 'main',
    label: 'Agent',
    icon: 'KeyRound',
    description: 'Credentials, secrets, and agent management',
    pinned: true,
  },
  {
    id: 'agents',
    label: 'Verify',
    icon: 'ShieldCheck',
    description: 'Verified credentials and identity attestations',
    pinned: true,
  },
];

/** Social view — only shown when SOCIAL feature flag is enabled */
export const SOCIAL_VIEW: ViewDefinition = {
  id: 'social',
  label: 'Social',
  icon: 'MessageCircle',
  description: 'Social feed, posts, reactions, and follows',
  pinned: true,
};

/** Hub view — renders a hub's frontend in an iframe */
export const HUB_VIEW: ViewDefinition = {
  id: 'hub',
  label: 'Hub',
  icon: 'Globe',
  description: 'Browse hub frontends',
  pinned: true,
};

/** Views that can be created from the + button */
export const CREATABLE_VIEWS: ViewDefinition[] = [
  {
    id: 'auth',
    label: 'Auth',
    icon: 'Shield',
    description: 'Token management and approval flows',
  },
  {
    id: 'wallet',
    label: 'Wallet',
    icon: 'Flame',
    description: 'Wallet balances, send, swap, and fund',
  },
  {
    id: 'audit',
    label: 'Audit',
    icon: 'Database',
    description: 'Audit logs and security monitoring',
  },
];

export function getDefaultActiveViewId(): string {
  return 'main';
}
