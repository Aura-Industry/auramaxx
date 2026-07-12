type FormType = 'login' | 'card' | 'sso' | 'note' | 'plain_note' | 'hot_wallet' | 'apikey' | 'oauth2' | 'ssh' | 'gpg' | 'custom';

type NameInputs = {
  type: FormType;
  name: string;
  apiKeyName: string;
  username: string;
  url: string;
  noteContent: string;
  customFieldKey: string;
  hotWalletChain: string;
  cardholder: string;
  cardNumber: string;
  cardBrand?: string;
  cardLast4?: string;
  ssoWebsite?: string;
  ssoProvider?: string;
  oauth2TokenEndpoint: string;
  sshHostsInput: string;
  gpgKeyId: string;
  gpgUidEmail: string;
};

const toCardBrandKey = (rawBrand: string): string => {
  const normalized = rawBrand.trim().toLowerCase();
  if (!normalized || normalized === 'other') return 'card';
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'card';
};

const resolveCardLast4 = (cardNumber: string, fallbackLast4: string): string => {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits.length >= 4) return digits.slice(-4);
  return fallbackLast4.replace(/\D/g, '').slice(-4);
};

const deriveNoteTitleFromContent = (raw: string): string => {
  const firstNonEmptyLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
  return firstNonEmptyLine.slice(0, 48);
};

const formatSsoProviderLabel = (rawProvider: string): string => {
  const normalized = rawProvider.trim().toLowerCase();
  if (!normalized) return '';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

export function deriveCredentialName(inputs: NameInputs): string {
  const {
    type,
    name,
    apiKeyName,
    username,
    url,
    noteContent,
    customFieldKey,
    hotWalletChain,
    cardNumber,
    cardBrand,
    cardLast4,
    ssoWebsite,
    ssoProvider,
    oauth2TokenEndpoint,
    sshHostsInput,
    gpgKeyId,
    gpgUidEmail,
  } = inputs;
  const safeHostsInput = sshHostsInput || '';
  const safeCardNumber = cardNumber || '';
  const safeCardBrand = cardBrand || '';
  const safeCardLast4 = cardLast4 || '';
  const safeSsoWebsite = ssoWebsite || '';
  const safeSsoProvider = ssoProvider || '';
  const safeOauth2TokenEndpoint = oauth2TokenEndpoint || '';
  const safeGpgKeyId = gpgKeyId || '';
  const safeGpgUidEmail = gpgUidEmail || '';
  const cardBrandKey = toCardBrandKey(safeCardBrand);
  const cardLast4Value = resolveCardLast4(safeCardNumber, safeCardLast4);
  const cardDisplayName = cardLast4Value
    ? `${cardBrandKey}_${cardLast4Value}`
    : cardBrandKey;
  const trimmedHosts = safeHostsInput
    .split(/\n|,/)
    .map((host) => host.trim())
    .filter(Boolean);
  const ssoProviderLabel = formatSsoProviderLabel(safeSsoProvider);
  const ssoWebsiteValue = safeSsoWebsite.trim();
  const ssoDisplayName = ssoProviderLabel && ssoWebsiteValue
    ? `${ssoProviderLabel} (${ssoWebsiteValue})`
    : ssoWebsiteValue || (ssoProviderLabel ? `${ssoProviderLabel} SSO` : 'SSO Login');
  const derivedNameByType: Partial<Record<FormType, string>> = {
    plain_note: deriveNoteTitleFromContent(noteContent),
    apikey: apiKeyName.trim(),
    login: username.trim() || url.trim() || 'Login',
    note: deriveNoteTitleFromContent(noteContent),
    hot_wallet: hotWalletChain.trim() ? `Hot Wallet (${hotWalletChain.trim().toUpperCase()})` : 'Hot Wallet',
    custom: customFieldKey.trim(),
    card: cardDisplayName,
    sso: ssoDisplayName,
    oauth2: safeOauth2TokenEndpoint.trim() || 'OAuth2',
    ssh: trimmedHosts[0] || 'SSH Key',
    gpg: safeGpgKeyId.trim() || safeGpgUidEmail.trim() || 'GPG Key',
  };
  if (type === 'card') return derivedNameByType.card || 'card';
  if (type === 'apikey') return derivedNameByType.apikey || name.trim();
  if (type === 'note' || type === 'plain_note') {
    return derivedNameByType[type] || name.trim();
  }
  return name.trim() || derivedNameByType[type] || '';
}

export function canDeriveName(inputs: Omit<NameInputs, 'name'>): boolean {
  const {
    type,
    apiKeyName,
    username,
    url,
    noteContent,
    customFieldKey,
    hotWalletChain,
    cardholder,
    cardNumber,
    cardLast4,
    ssoWebsite,
    ssoProvider,
    oauth2TokenEndpoint,
    sshHostsInput,
    gpgKeyId,
    gpgUidEmail,
  } = inputs;

  return (
    (type === 'apikey' && !!apiKeyName.trim())
    || (type === 'plain_note' && !!noteContent.trim())
    || (type === 'login' && (!!username.trim() || !!url.trim()))
    || (type === 'note' && !!noteContent.trim())
    || (type === 'hot_wallet' && (!!hotWalletChain.trim() || true))
    || (type === 'custom' && !!customFieldKey.trim())
    || (type === 'card' && (!!cardholder?.trim() || !!cardNumber?.trim() || !!cardLast4?.trim()))
    || (type === 'sso' && (!!ssoWebsite?.trim() || !!ssoProvider?.trim()))
    || (type === 'oauth2' && !!oauth2TokenEndpoint?.trim())
    || (type === 'ssh' && !!sshHostsInput?.trim())
    || (type === 'gpg' && (!!gpgKeyId?.trim() || !!gpgUidEmail?.trim()))
  );
}
