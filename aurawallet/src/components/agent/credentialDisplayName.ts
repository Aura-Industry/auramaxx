import type { CredentialMeta } from './types';

const CARD_ENV_NAME_WITH_LAST4 = /^([a-z0-9]+(?:_[a-z0-9]+)*)_(\d{4})$/;
const CARD_ENV_NAME_KEY = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

const CARD_BRAND_LABELS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  discover: 'Discover',
  card: 'Card',
};

const toCardBrandLabel = (brandKey: string): string => {
  const normalized = brandKey.trim().toLowerCase();
  if (!normalized) return 'Card';
  if (CARD_BRAND_LABELS[normalized]) return CARD_BRAND_LABELS[normalized];
  return normalized
    .split('_')
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
};

export const getCredentialDisplayName = (credential: Pick<CredentialMeta, 'type' | 'name'>): string => {
  if (credential.type !== 'card') return credential.name;

  const rawName = (credential.name || '').trim();
  if (!rawName) return 'Card';

  const envNameWithLast4 = rawName.match(CARD_ENV_NAME_WITH_LAST4);
  if (envNameWithLast4) {
    const [, brandKey, last4] = envNameWithLast4;
    return `${toCardBrandLabel(brandKey)} ••••${last4}`;
  }

  if (CARD_ENV_NAME_KEY.test(rawName) && rawName === rawName.toLowerCase()) {
    return toCardBrandLabel(rawName);
  }

  return rawName;
};
