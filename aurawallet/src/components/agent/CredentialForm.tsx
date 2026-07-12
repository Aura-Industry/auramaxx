'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Key, Eye, Loader2, CreditCard, FileText, RefreshCw, ArrowLeft, Wallet, Upload, Apple, Facebook, Chrome } from 'lucide-react';
import { Button, TextInput, FilterDropdown, Modal, Toggle, ItemPicker } from '@/components/design-system';
import { api, Api } from '@/lib/api';
import { decryptCredentialPayload } from '@/lib/agent-crypto';
import { renderMarkdownToHtml } from '@/lib/markdown';
import {
  CREDENTIAL_FIELD_KEYS,
  CREDENTIAL_FIELD_SCHEMA,
  canonicalizeCredentialFieldKey,
  NOTE_CONTENT_KEY,
  getCredentialPrimaryFieldKey,
  getCredentialPrimaryFieldSpec,
} from '@/lib/credential-field-schema';
import { PasswordGenerator } from './PasswordGenerator';
import { TotpSetupPanel } from './TotpSetupPanel';
import { deriveCredentialName, canDeriveName as canDeriveNameFromInputs } from './credentialFormName';
import type { AgentInfo, CredentialMeta, WalletLinkMetaV1 } from './types';

interface CredentialFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (credentialId?: string) => void | Promise<void>;
  editCredentialId?: string;
  agents: AgentInfo[];
  createStartStep?: 'type' | 'form';
  createStartType?: FormType;
  createPrefill?: {
    agentId?: string;
    tags?: string[];
    type?: FormType;
    name?: string;
    noteContent?: string;
  };
}

type FormType = 'login' | 'card' | 'sso' | 'note' | 'plain_note' | 'hot_wallet' | 'apikey' | 'oauth2' | 'ssh' | 'gpg' | 'custom';

const LOGIN_FIELD_KEYS = CREDENTIAL_FIELD_KEYS.login;
const CARD_FIELD_KEYS = CREDENTIAL_FIELD_KEYS.card;
const SSO_FIELD_KEYS = CREDENTIAL_FIELD_KEYS.sso;
const HOT_WALLET_FIELD_KEYS = CREDENTIAL_FIELD_KEYS.hot_wallet;
const APIKEY_FIELD_KEYS = CREDENTIAL_FIELD_KEYS.apikey;
const OAUTH2_FIELD_KEYS = CREDENTIAL_FIELD_KEYS.oauth2;
const SSH_FIELD_KEYS = CREDENTIAL_FIELD_KEYS.ssh;
const GPG_FIELD_KEYS = CREDENTIAL_FIELD_KEYS.gpg;

const TYPE_META: Record<FormType, {
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = {
  hot_wallet: { label: 'Hot Wallet', description: 'Generate wallet address + encrypted private key', icon: Wallet },
  plain_note: { label: 'Plain Note', description: 'Readable note content stored without encryption', icon: FileText },
  apikey: { label: 'API Key', description: 'Simple key/value secret', icon: Key },
  login: { label: 'Login', description: 'Websites and app accounts', icon: Key },
  sso: { label: 'SSO Login', description: 'Website + identity provider references', icon: RefreshCw },
  note: { label: 'Secure Note', description: 'Private notes and secrets', icon: FileText },
  card: { label: 'Credit Card', description: 'Payment cards and details', icon: CreditCard },
  oauth2: { label: 'OAuth2', description: 'Auto-refreshing OAuth2 tokens', icon: RefreshCw },
  ssh: { label: 'SSH Key', description: 'Private/public keypair for SSH', icon: Key },
  gpg: { label: 'GPG Key', description: 'Armored key material and metadata', icon: FileText },
  custom: { label: 'Key / Value', description: 'Define a custom key/value secret field', icon: FileText },
};

const FEATURED_TYPE_ORDER: FormType[] = ['apikey', 'login', 'plain_note'];
const REMAINING_TYPE_ORDER: FormType[] = ['custom', 'card', 'hot_wallet', 'sso', 'note', 'oauth2', 'ssh', 'gpg'];
const NOTE_IMPORT_ACCEPT = '.md,.markdown,.txt,text/markdown,text/plain';

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function normalizeHotWalletChain(raw: string | undefined): 'base' | 'solana' {
  const chain = (raw || '').trim().toLowerCase();
  if (chain === 'solana' || chain === 'solana-devnet') return 'solana';
  return 'base';
}

function getParentAgentId(agent: AgentInfo): string | undefined {
  return agent.parentAgentId || agent.linkedTo;
}

const BRAND_OPTIONS = [
  { value: 'visa', label: 'Visa' },
  { value: 'mastercard', label: 'Mastercard' },
  { value: 'amex', label: 'Amex' },
  { value: 'discover', label: 'Discover' },
  { value: 'other', label: 'Other' },
];

const SSO_PROVIDER_OPTIONS = [
  { value: 'apple', label: 'Apple', icon: <Apple size={14} /> },
  { value: 'facebook', label: 'Facebook', icon: <Facebook size={14} /> },
  { value: 'google', label: 'Google', icon: <Chrome size={14} /> },
];

const normalizeForRank = (value: string) => value.trim().toLowerCase();

const toTimestamp = (updatedAt?: string, createdAt?: string) => {
  const updated = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (Number.isFinite(updated)) return updated;
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (Number.isFinite(created)) return created;
  return 0;
};

export const CredentialForm: React.FC<CredentialFormProps> = ({
  isOpen,
  onClose,
  onSaved,
  editCredentialId,
  agents,
  createStartStep = 'form',
  createStartType,
  createPrefill,
}) => {
  const [type, setType] = useState<FormType>('apikey');
  const [createStep, setCreateStep] = useState<'type' | 'form'>('form');
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [favorite, setFavorite] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');

  // Login fields
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginNotes, setLoginNotes] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpIntent, setTotpIntent] = useState<'keep' | 'replace' | 'remove'>('keep');
  const [hasExistingTotp, setHasExistingTotp] = useState(false);

  // Card fields
  const [cardholder, setCardholder] = useState('');
  const [brand, setBrand] = useState('visa');
  const [cardLast4, setCardLast4] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [billingZip, setBillingZip] = useState('');
  const [cardNotes, setCardNotes] = useState('');

  // SSO fields
  const [ssoWebsite, setSsoWebsite] = useState('');
  const [ssoProvider, setSsoProvider] = useState('');
  const [ssoIdentifier, setSsoIdentifier] = useState('');

  // Note fields
  const [noteContent, setNoteContent] = useState('');

  // Hot wallet fields
  const [hotWalletChain, setHotWalletChain] = useState('base');
  const [hotWalletAddress, setHotWalletAddress] = useState('');

  // API key fields
  const [apiKeyName, setApiKeyName] = useState('');
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [customFieldKey, setCustomFieldKey] = useState('value');
  const [customFieldValue, setCustomFieldValue] = useState('');

  // OAuth2 fields
  const [oauth2TokenEndpoint, setOauth2TokenEndpoint] = useState('');
  const [oauth2ClientId, setOauth2ClientId] = useState('');
  const [oauth2ClientSecret, setOauth2ClientSecret] = useState('');
  const [oauth2AccessToken, setOauth2AccessToken] = useState('');
  const [oauth2RefreshToken, setOauth2RefreshToken] = useState('');
  const [oauth2Scopes, setOauth2Scopes] = useState('');
  const [oauth2AuthMethod, setOauth2AuthMethod] = useState('client_secret_post');
  const [oauth2ExpiresAt, setOauth2ExpiresAt] = useState('');


  // SSH fields
  const [sshPublicKey, setSshPublicKey] = useState('');
  const [sshPrivateKey, setSshPrivateKey] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');
  const [sshHostsInput, setSshHostsInput] = useState('');
  const [sshKeyType, setSshKeyType] = useState('');

  // GPG fields
  const [gpgPublicKey, setGpgPublicKey] = useState('');
  const [gpgPrivateKey, setGpgPrivateKey] = useState('');
  const [gpgKeyId, setGpgKeyId] = useState('');
  const [gpgUidEmail, setGpgUidEmail] = useState('');
  const [gpgExpiresAt, setGpgExpiresAt] = useState('');

  // Preserve any existing wallet link metadata during edits.
  const [walletLink, setWalletLink] = useState<WalletLinkMetaV1 | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPasswordGen, setShowPasswordGen] = useState(false);
  const [showPasswordActions, setShowPasswordActions] = useState(false);
  const [showGlobalAdvanced, setShowGlobalAdvanced] = useState(false);
  const [showUsernameSuggestions, setShowUsernameSuggestions] = useState(false);
  const [usernameSuggestions, setUsernameSuggestions] = useState<string[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [revealingField, setRevealingField] = useState<string | null>(null);
  const [sensitiveFieldCache, setSensitiveFieldCache] = useState<Record<string, string> | null>(null);
  const [dirtySensitiveFields, setDirtySensitiveFields] = useState<Record<string, boolean>>({});
  const dirtySensitiveFieldsRef = useRef<Record<string, boolean>>({});
  const [visibleSensitiveFields, setVisibleSensitiveFields] = useState<Record<string, boolean>>({});
  const passwordActionsRef = useRef<HTMLDivElement | null>(null);
  const noteImportInputRef = useRef<HTMLInputElement | null>(null);
  const [noteEditorMode, setNoteEditorMode] = useState<'write' | 'preview'>('write');

  const isEdit = !!editCredentialId;

  const setSensitiveFieldValue = useCallback((fieldKey: string, value: string, credentialType: FormType) => {
    const canonicalFieldKey = canonicalizeCredentialFieldKey(credentialType, fieldKey);

    switch (canonicalFieldKey) {
      case LOGIN_FIELD_KEYS.password:
        setPassword(value);
        break;
      case LOGIN_FIELD_KEYS.notes:
        if (credentialType === 'login') setLoginNotes(value);
        if (credentialType === 'card') setCardNotes(value);
        break;
      case CARD_FIELD_KEYS.number:
        setCardNumber(value);
        setCardLast4(value.replace(/\D/g, '').slice(-4));
        break;
      case CARD_FIELD_KEYS.expiry:
        setExpiry(value);
        break;
      case CARD_FIELD_KEYS.cvv:
        setCvv(value);
        break;
      case NOTE_CONTENT_KEY:
        setNoteContent(value);
        break;
      case APIKEY_FIELD_KEYS.value:
        setApiKeyValue(value);
        break;
      case OAUTH2_FIELD_KEYS.accessToken:
        setOauth2AccessToken(value);
        break;
      case OAUTH2_FIELD_KEYS.refreshToken:
        setOauth2RefreshToken(value);
        break;
      case OAUTH2_FIELD_KEYS.clientId:
        setOauth2ClientId(value);
        break;
      case OAUTH2_FIELD_KEYS.clientSecret:
        setOauth2ClientSecret(value);
        break;
      case SSH_FIELD_KEYS.privateKey:
        if (credentialType === 'ssh') setSshPrivateKey(value);
        if (credentialType === 'gpg') setGpgPrivateKey(value);
        break;
      case SSH_FIELD_KEYS.passphrase:
        setSshPassphrase(value);
        break;
      default:
        if (credentialType === 'custom') setCustomFieldValue(value);
        break;
    }
  }, []);

  useEffect(() => {
    dirtySensitiveFieldsRef.current = dirtySensitiveFields;
  }, [dirtySensitiveFields]);

  const markSensitiveDirty = useCallback((fieldKey: string) => {
    const canonicalFieldKey = canonicalizeCredentialFieldKey(type, fieldKey);
    setDirtySensitiveFields((prev) => ({ ...prev, [canonicalFieldKey]: true }));
    dirtySensitiveFieldsRef.current = {
      ...dirtySensitiveFieldsRef.current,
      [canonicalFieldKey]: true,
    };
  }, [type]);

  const parentAgents = useMemo(
    () => agents.filter((agent) => !getParentAgentId(agent)),
    [agents],
  );

  // Default agent
  useEffect(() => {
    if (agentId) return;
    const defaultSource = parentAgents.length > 0 ? parentAgents : agents;
    if (defaultSource.length > 0) {
      const primary = defaultSource.find((v) => v.isPrimary);
      setAgentId(primary?.id || defaultSource[0].id);
    }
  }, [agents, parentAgents, agentId]);

  // Load existing credential for editing
  const loadCredential = useCallback(async () => {
    if (!editCredentialId) return;
    try {
      const res = await api.get<{ success: boolean; credential: CredentialMeta }>(Api.Wallet, `/credentials/${editCredentialId}`);
      const cred = res.credential;
      const credentialType = cred.type as FormType;
      setName(cred.name);
      setType(credentialType);
      setAgentId(cred.agentId);
      setFavorite(cred.meta.favorite || false);
      setTags(cred.meta.tags || []);
      const existingWalletLink = cred.meta.walletLink as WalletLinkMetaV1 | undefined;
      setWalletLink(existingWalletLink?.walletAddress && (existingWalletLink.tier === 'hot' || existingWalletLink.tier === 'cold') ? existingWalletLink : null);

      if (cred.type === 'login') {
        setUrl((cred.meta[LOGIN_FIELD_KEYS.url] as string) || '');
        setUsername((cred.meta[LOGIN_FIELD_KEYS.username] as string) || '');
        setHasExistingTotp(Boolean(cred.meta.has_totp));
      } else if (cred.type === 'card') {
        setCardholder((cred.meta[CARD_FIELD_KEYS.cardholder] as string) || '');
        setBrand((cred.meta[CARD_FIELD_KEYS.brand] as string) || 'visa');
        setCardLast4((cred.meta[CARD_FIELD_KEYS.last4] as string) || '');
        setBillingZip((cred.meta[CARD_FIELD_KEYS.billingZip] as string) || '');
      } else if (cred.type === 'sso') {
        setSsoWebsite((cred.meta[SSO_FIELD_KEYS.website] as string) || '');
        setSsoProvider((cred.meta[SSO_FIELD_KEYS.provider] as string) || '');
        setSsoIdentifier((cred.meta[SSO_FIELD_KEYS.identifier] as string) || '');
      } else if (cred.type === 'apikey') {
        setApiKeyName((cred.meta[APIKEY_FIELD_KEYS.key] as string) || '');
        setApiKeyValue((cred.meta[APIKEY_FIELD_KEYS.value] as string) || '');
      } else if (cred.type === 'plain_note') {
        setNoteContent(
          (cred.meta[NOTE_CONTENT_KEY] as string)
          || (cred.meta[APIKEY_FIELD_KEYS.value] as string)
          || '',
        );
      } else if (cred.type === 'oauth2') {
        setOauth2TokenEndpoint((cred.meta[OAUTH2_FIELD_KEYS.tokenEndpoint] as string) || '');
        setOauth2Scopes((cred.meta[OAUTH2_FIELD_KEYS.scopes] as string) || '');
        setOauth2AuthMethod((cred.meta[OAUTH2_FIELD_KEYS.authMethod] as string) || 'client_secret_post');
        setOauth2ExpiresAt(
          typeof cred.meta[OAUTH2_FIELD_KEYS.expiresAt] === 'number'
            ? String(cred.meta[OAUTH2_FIELD_KEYS.expiresAt])
            : typeof cred.meta[OAUTH2_FIELD_KEYS.expiresAt] === 'string'
              ? cred.meta[OAUTH2_FIELD_KEYS.expiresAt] as string
              : '',
        );
      } else if (cred.type === 'hot_wallet') {
        setHotWalletAddress(
          (cred.meta[HOT_WALLET_FIELD_KEYS.address] as string)
          || existingWalletLink?.walletAddress
          || '',
        );
        setHotWalletChain(
          normalizeHotWalletChain(
            (cred.meta[HOT_WALLET_FIELD_KEYS.chain] as string)
            || existingWalletLink?.chain,
          ),
        );
      } else if (cred.type === 'ssh') {
        setSshPublicKey((cred.meta[SSH_FIELD_KEYS.publicKey] as string) || '');
        setSshHostsInput(Array.isArray(cred.meta[SSH_FIELD_KEYS.hosts]) ? (cred.meta[SSH_FIELD_KEYS.hosts] as string[]).join('\n') : '');
        setSshKeyType((cred.meta[SSH_FIELD_KEYS.keyType] as string) || '');
      } else if (cred.type === 'gpg') {
        setGpgPublicKey((cred.meta[GPG_FIELD_KEYS.publicKey] as string) || '');
        setGpgKeyId((cred.meta[GPG_FIELD_KEYS.keyId] as string) || '');
        setGpgUidEmail((cred.meta[GPG_FIELD_KEYS.uidEmail] as string) || '');
        setGpgExpiresAt((cred.meta[GPG_FIELD_KEYS.expiresAt] as string) || '');
      }

      // Hydrate sensitive values on edit so the modal has actual secret values immediately.
      const schema = CREDENTIAL_FIELD_SCHEMA[credentialType];
      const hasSensitiveEditableFields = credentialType === 'custom'
        || (credentialType !== 'hot_wallet' && (schema || []).some((field) => field.sensitive));
      if (hasSensitiveEditableFields) {
        try {
          const readRes = await api.post<{ encrypted: string }>(Api.Wallet, `/credentials/${editCredentialId}/read`);
          const plaintext = await decryptCredentialPayload(readRes.encrypted);
          const parsed = JSON.parse(plaintext) as { fields?: Array<{ key: string; value: string }> };
          const fieldMap: Record<string, string> = {};

          (parsed.fields || []).forEach((field) => {
            const canonicalFieldKey = canonicalizeCredentialFieldKey(credentialType, field.key);
            fieldMap[canonicalFieldKey] = field.value;
          });

          setSensitiveFieldCache(fieldMap);
          Object.entries(fieldMap).forEach(([fieldKey, fieldValue]) => {
            if (dirtySensitiveFieldsRef.current[fieldKey]) return;
            setSensitiveFieldValue(fieldKey, fieldValue, credentialType);
          });
        } catch {
          // Keep masked placeholders if read/decrypt fails; manual reveal can retry.
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credential');
    }
  }, [editCredentialId, setSensitiveFieldValue]);

  const getSensitiveFieldMap = useCallback(async (): Promise<Record<string, string>> => {
    if (!isEdit || !editCredentialId) return {};
    if (sensitiveFieldCache) return sensitiveFieldCache;

    const res = await api.post<{ encrypted: string }>(Api.Wallet, `/credentials/${editCredentialId}/read`);
    const plaintext = await decryptCredentialPayload(res.encrypted);
    const parsed = JSON.parse(plaintext) as { fields?: Array<{ key: string; value: string }> };
    const fieldMap: Record<string, string> = {};

    (parsed.fields || []).forEach((field) => {
      const canonicalFieldKey = canonicalizeCredentialFieldKey(type, field.key);
      fieldMap[canonicalFieldKey] = field.value;
    });

    setSensitiveFieldCache(fieldMap);
    return fieldMap;
  }, [isEdit, editCredentialId, sensitiveFieldCache, type]);

  const handleRevealField = useCallback(async (fieldKey: string) => {
    if (!isEdit) return;
    setRevealingField(fieldKey);
    setError(null);
    try {
      const fieldMap = await getSensitiveFieldMap();
      const canonicalFieldKey = canonicalizeCredentialFieldKey(type, fieldKey);
      if (dirtySensitiveFieldsRef.current[canonicalFieldKey]) return;
      setSensitiveFieldValue(
        fieldKey,
        fieldMap[canonicalFieldKey] || fieldMap[fieldKey] || '',
        type,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decryption failed -- try re-unlocking');
    } finally {
      setRevealingField(null);
    }
  }, [getSensitiveFieldMap, isEdit, setSensitiveFieldValue]);

  const getSensitiveFieldValue = useCallback((fieldKey: string): string => {
    const canonicalFieldKey = canonicalizeCredentialFieldKey(type, fieldKey);
    switch (canonicalFieldKey) {
      case LOGIN_FIELD_KEYS.password:
        return password;
      case APIKEY_FIELD_KEYS.value:
        return apiKeyValue;
      case CREDENTIAL_FIELD_KEYS.custom.value:
        return customFieldValue;
      default:
        return type === 'custom' ? customFieldValue : '';
    }
  }, [apiKeyValue, customFieldValue, password, type]);

  const isSensitiveFieldVisible = useCallback((fieldKey: string) => {
    const canonicalFieldKey = canonicalizeCredentialFieldKey(type, fieldKey);
    return !!visibleSensitiveFields[canonicalFieldKey];
  }, [type, visibleSensitiveFields]);

  const toggleSensitiveFieldVisibility = useCallback(async (fieldKey: string) => {
    const canonicalFieldKey = canonicalizeCredentialFieldKey(type, fieldKey);
    if (visibleSensitiveFields[canonicalFieldKey]) {
      setVisibleSensitiveFields((prev) => ({ ...prev, [canonicalFieldKey]: false }));
      return;
    }

    // Edit mode values may be masked placeholders until decrypted.
    if (isEdit && !getSensitiveFieldValue(fieldKey).trim()) {
      await handleRevealField(fieldKey);
    }

    setVisibleSensitiveFields((prev) => ({ ...prev, [canonicalFieldKey]: true }));
  }, [getSensitiveFieldValue, handleRevealField, isEdit, type, visibleSensitiveFields]);

  useEffect(() => {
    if (isOpen) {
      if (!isEdit) {
        setCreateStep(createStartStep);
        if (createStartType) {
          setType(createStartType);
        }
        if (createPrefill?.type) {
          setType(createPrefill.type);
        }
        if (createPrefill?.agentId) {
          setAgentId(createPrefill.agentId);
        }
        if (createPrefill?.tags && createPrefill.tags.length > 0) {
          setTags(createPrefill.tags);
        }
        if (createPrefill?.name) {
          setName(createPrefill.name);
        }
        if (createPrefill?.noteContent) {
          setNoteContent(createPrefill.noteContent);
        }
      } else {
        setCreateStep('form');
      }
      setShowGlobalAdvanced(false);
      setShowPasswordActions(false);
      setVisibleSensitiveFields({});
      setTotpIntent(isEdit ? 'keep' : 'replace');
    }
  }, [isOpen, isEdit, createStartStep, createStartType, createPrefill]);

  useEffect(() => {
    if (!isOpen || isEdit || type !== 'oauth2' || oauth2ExpiresAt) return;
    setOauth2ExpiresAt(String(Math.floor(Date.now() / 1000) + 60 * 60));
  }, [isOpen, isEdit, type, oauth2ExpiresAt]);

  useEffect(() => {
    if (!isOpen) return;

    const loadSuggestions = async () => {
      try {
        const res = await api.get<{ success: boolean; credentials: CredentialMeta[] }>(Api.Wallet, '/credentials');
        const creds = res.credentials || [];

        const loginCreds = creds.filter((c) => c.type === 'login');
        const usernameStats = new Map<string, { raw: string; frequency: number; recent: number }>();

        loginCreds.forEach((credential) => {
          const raw = String(credential.meta.username || '').trim();
          if (!raw) return;
          const normalized = normalizeForRank(raw);
          const timestamp = toTimestamp(credential.updatedAt, credential.createdAt);
          const existing = usernameStats.get(normalized);
          if (!existing) {
            usernameStats.set(normalized, { raw, frequency: 1, recent: timestamp });
            return;
          }
          existing.frequency += 1;
          if (timestamp > existing.recent) {
            existing.recent = timestamp;
            existing.raw = raw;
          }
        });

        const usernames = Array.from(usernameStats.entries())
          .sort((a, b) => {
            if (b[1].recent !== a[1].recent) return b[1].recent - a[1].recent;
            if (b[1].frequency !== a[1].frequency) return b[1].frequency - a[1].frequency;
            return a[0].localeCompare(b[0]);
          })
          .map(([, value]) => value.raw)
          .slice(0, 20);

        const tagStats = new Map<string, { frequency: number; recent: number }>();
        creds.forEach((credential) => {
          const timestamp = toTimestamp(credential.updatedAt, credential.createdAt);
          const uniqueTags = new Set((Array.isArray(credential.meta.tags) ? credential.meta.tags : [])
            .map((t) => String(t).trim())
            .filter(Boolean));
          uniqueTags.forEach((tag) => {
            const normalized = normalizeForRank(tag);
            const existing = tagStats.get(normalized);
            if (!existing) {
              tagStats.set(normalized, { frequency: 1, recent: timestamp });
              return;
            }
            existing.frequency += 1;
            if (timestamp > existing.recent) existing.recent = timestamp;
          });
        });

        const tagsFromAgent = Array.from(tagStats.entries())
          .sort((a, b) => {
            if (b[1].recent !== a[1].recent) return b[1].recent - a[1].recent;
            if (b[1].frequency !== a[1].frequency) return b[1].frequency - a[1].frequency;
            return a[0].localeCompare(b[0]);
          })
          .map(([tag]) => tag)
          .slice(0, 30);

        setUsernameSuggestions(usernames);
        setTagSuggestions(tagsFromAgent);
      } catch {
        setUsernameSuggestions([]);
        setTagSuggestions([]);
      }
    };

    void loadSuggestions();
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && editCredentialId) {
      setSensitiveFieldCache(null);
      setDirtySensitiveFields({});
      dirtySensitiveFieldsRef.current = {};
      loadCredential();
    }
  }, [isOpen, editCredentialId, loadCredential]);

  useEffect(() => {
    if (!isOpen) {
      setName('');
      setAgentId('');
      setFavorite(false);
      setTags([]);
      setTagInput('');
      setUrl('');
      setUsername('');
      setPassword('');
      setLoginNotes('');
      setTotpSecret('');
      setTotpIntent('keep');
      setHasExistingTotp(false);
      setCardholder('');
      setBrand('visa');
      setCardLast4('');
      setCardNumber('');
      setExpiry('');
      setCvv('');
      setBillingZip('');
      setCardNotes('');
      setSsoWebsite('');
      setSsoProvider('');
      setSsoIdentifier('');
      setNoteContent('');
      setHotWalletChain('base');
      setHotWalletAddress('');
      setApiKeyName('');
      setApiKeyValue('');
      setCustomFieldKey('value');
      setCustomFieldValue('');
      setOauth2TokenEndpoint('');
      setOauth2ClientId('');
      setOauth2ClientSecret('');
      setOauth2AccessToken('');
      setOauth2RefreshToken('');
      setOauth2Scopes('');
      setOauth2AuthMethod('client_secret_post');
      setOauth2ExpiresAt('');
      setSshPublicKey('');
      setSshPrivateKey('');
      setSshPassphrase('');
      setSshHostsInput('');
      setSshKeyType('');
      setGpgPublicKey('');
      setGpgPrivateKey('');
      setGpgKeyId('');
      setGpgUidEmail('');
      setGpgExpiresAt('');
      setWalletLink(null);
      setError(null);
      setSaving(false);
      setShowPasswordActions(false);
      setRevealingField(null);
      setSensitiveFieldCache(null);
      setDirtySensitiveFields({});
      dirtySensitiveFieldsRef.current = {};
      setVisibleSensitiveFields({});
      setShowGlobalAdvanced(false);
      setShowUsernameSuggestions(false);
      setNoteEditorMode('write');
    }
  }, [isOpen]);

  useEffect(() => {
    if (type !== 'login') {
      setShowPasswordActions(false);
    }
  }, [type]);

  const agentOptions = parentAgents.map((v) => ({
    value: v.id,
    label: v.name || (v.isPrimary ? 'Primary' : v.id.slice(0, 8)),
  }));

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const tag = tagInput.trim();
      if (tag && !tags.includes(tag)) {
        setTags([...tags, tag]);
      }
      setTagInput('');
    }
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  const openMarkdownFilePicker = useCallback(() => {
    noteImportInputRef.current?.click();
  }, []);

  const readNoteImportFileText = useCallback((file: File): Promise<string> => {
    if (typeof file.text === 'function') {
      return file.text();
    }

    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read note file'));
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.readAsText(file);
    });
  }, []);

  const handleNoteImport = useCallback(async (file: File | null) => {
    if (!file) return;
    setError(null);
    const lowerName = file.name.toLowerCase();
    if (!(lowerName.endsWith('.md') || lowerName.endsWith('.markdown') || lowerName.endsWith('.txt'))) {
      setError('Please choose a Markdown or text file (.md, .markdown, .txt).');
      return;
    }

    try {
      const content = await readNoteImportFileText(file);
      if (!content.trim()) {
        setError('The selected note file is empty.');
        return;
      }
      setNoteContent(content);
      if (isEdit && type === 'note') {
        markSensitiveDirty(NOTE_CONTENT_KEY);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import note file');
    }
  }, [isEdit, markSensitiveDirty, readNoteImportFileText, type]);

  const handleMarkdownFileInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    void handleNoteImport(file);
    event.currentTarget.value = '';
  }, [handleNoteImport]);

  const visibleTagSuggestions = tagSuggestions
    .filter((tag) => !tags.includes(tag))
    .filter((tag) => !tagInput.trim() || tag.toLowerCase().includes(tagInput.trim().toLowerCase()))
    .slice(0, 6);

  const notePreviewHtml = useMemo(() => {
    if (!noteContent.trim()) return '';
    return renderMarkdownToHtml(escapeHtml(noteContent), {
      preserveSingleLineBreaks: true,
      decodeEscapedNewlines: true,
    });
  }, [noteContent]);

  const canShortcutSave = useCallback(() => {
    const canDeriveName = canDeriveNameFromInputs({
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
    });

    if (!name.trim() && !canDeriveName) return false;

    if (type === 'login' && !isEdit && !password.trim()) return false;
    if (type === 'login' && isEdit && totpIntent === 'replace' && !totpSecret.trim()) return false;
    if (type === 'plain_note' && !noteContent.trim()) return false;
    if (type === 'apikey' && (!apiKeyName.trim() || !apiKeyValue.trim())) return false;
    if (type === 'custom' && (!customFieldKey.trim() || !customFieldValue.trim())) return false;
    if (type === 'sso' && (!ssoWebsite.trim() || !ssoProvider.trim())) return false;
    if (type === 'ssh' && !sshPrivateKey.trim() && !isEdit) return false;
    if (type === 'gpg' && !gpgPrivateKey.trim() && !isEdit) return false;

    if (type === 'oauth2') {
      if (!oauth2TokenEndpoint.trim()) return false;
      const expiresAtNumber = Number.parseInt(oauth2ExpiresAt, 10);
      if (!Number.isFinite(expiresAtNumber) || expiresAtNumber <= 0) return false;
      if (!isEdit) {
        if (!oauth2AccessToken.trim()) return false;
        if (!oauth2RefreshToken.trim()) return false;
        if (!oauth2ClientId.trim()) return false;
        if (!oauth2ClientSecret.trim()) return false;
      }
    }

    return true;
  }, [
    apiKeyName,
    apiKeyValue,
    cardNumber,
    cardLast4,
    cardholder,
    customFieldKey,
    customFieldValue,
    gpgKeyId,
    gpgPrivateKey,
    gpgUidEmail,
    hotWalletChain,
    isEdit,
    name,
    noteContent,
    oauth2AccessToken,
    oauth2ClientId,
    oauth2ClientSecret,
    oauth2ExpiresAt,
    oauth2RefreshToken,
    oauth2TokenEndpoint,
    password,
    ssoProvider,
    ssoWebsite,
    sshHostsInput,
    sshPrivateKey,
    totpIntent,
    totpSecret,
    type,
    url,
    username,
  ]);

  const buildPayload = () => {
    const cardNumberDigits = cardNumber.replace(/\D/g, '');
    const resolvedCardLast4 = cardNumberDigits.length >= 4 ? cardNumberDigits.slice(-4) : cardLast4.trim();
    const resolvedName = deriveCredentialName({
      type,
      name,
      apiKeyName,
      username,
      url,
      noteContent,
      customFieldKey,
      hotWalletChain,
      cardholder,
      cardNumber,
      cardBrand: brand,
      cardLast4: resolvedCardLast4,
      ssoWebsite,
      ssoProvider,
      oauth2TokenEndpoint,
      sshHostsInput,
      gpgKeyId,
      gpgUidEmail,
    });
    const resolvedCustomFieldKey = customFieldKey.trim() || getCredentialPrimaryFieldKey(type);
    const fields: { key: string; value: string; type: string; sensitive: boolean }[] = [];
    let meta: Record<string, unknown> = { tags, favorite };

    switch (type) {
      case 'login':
        if (url) fields.push({ key: LOGIN_FIELD_KEYS.url, value: url, type: 'text', sensitive: false });
        fields.push({ key: LOGIN_FIELD_KEYS.username, value: username, type: 'text', sensitive: false });
        fields.push({ key: LOGIN_FIELD_KEYS.password, value: password, type: 'secret', sensitive: true });
        if (loginNotes.trim() || (isEdit && dirtySensitiveFields[LOGIN_FIELD_KEYS.notes])) fields.push({ key: LOGIN_FIELD_KEYS.notes, value: loginNotes, type: 'text', sensitive: true });
        if (isEdit) {
          if (totpIntent === 'replace' && totpSecret.trim()) {
            fields.push({ key: LOGIN_FIELD_KEYS.totp, value: totpSecret.trim().replace(/\s+/g, '').toUpperCase(), type: 'secret', sensitive: true });
          }
          if (totpIntent === 'remove') {
            fields.push({ key: LOGIN_FIELD_KEYS.totp, value: '', type: 'secret', sensitive: true });
          }
        } else if (totpSecret.trim()) {
          fields.push({ key: LOGIN_FIELD_KEYS.totp, value: totpSecret.trim().replace(/\s+/g, '').toUpperCase(), type: 'secret', sensitive: true });
        }
        meta = { ...meta, [LOGIN_FIELD_KEYS.url]: url, [LOGIN_FIELD_KEYS.username]: username };
        break;
      case 'card':
        fields.push({ key: CARD_FIELD_KEYS.cardholder, value: cardholder, type: 'text', sensitive: false });
        fields.push({ key: CARD_FIELD_KEYS.number, value: cardNumber, type: 'text', sensitive: true });
        fields.push({ key: CARD_FIELD_KEYS.cvv, value: cvv, type: 'secret', sensitive: true });
        fields.push({ key: CARD_FIELD_KEYS.expiry, value: expiry, type: 'text', sensitive: true });
        if (cardNotes.trim() || (isEdit && dirtySensitiveFields[CARD_FIELD_KEYS.notes])) fields.push({ key: CARD_FIELD_KEYS.notes, value: cardNotes, type: 'text', sensitive: true });
        meta = {
          ...meta,
          [CARD_FIELD_KEYS.brand]: brand,
          [CARD_FIELD_KEYS.cardholder]: cardholder,
          [CARD_FIELD_KEYS.last4]: resolvedCardLast4,
          [CARD_FIELD_KEYS.billingZip]: billingZip,
        };
        break;
      case 'sso':
        fields.push({ key: SSO_FIELD_KEYS.website, value: ssoWebsite.trim(), type: 'text', sensitive: false });
        fields.push({ key: SSO_FIELD_KEYS.provider, value: ssoProvider.trim().toLowerCase(), type: 'text', sensitive: false });
        fields.push({ key: SSO_FIELD_KEYS.identifier, value: ssoIdentifier.trim(), type: 'text', sensitive: false });
        meta = {
          ...meta,
          [SSO_FIELD_KEYS.website]: ssoWebsite.trim(),
          [SSO_FIELD_KEYS.provider]: ssoProvider.trim().toLowerCase(),
          [SSO_FIELD_KEYS.identifier]: ssoIdentifier.trim(),
        };
        break;
      case 'note':
        fields.push({ key: NOTE_CONTENT_KEY, value: noteContent, type: 'text', sensitive: true });
        break;
      case 'hot_wallet':
        if (isEdit && hotWalletAddress.trim()) {
          fields.push({ key: HOT_WALLET_FIELD_KEYS.address, value: hotWalletAddress.trim(), type: 'text', sensitive: false });
        }
        meta = {
          ...meta,
          [HOT_WALLET_FIELD_KEYS.chain]: hotWalletChain,
          ...(hotWalletAddress.trim() ? { [HOT_WALLET_FIELD_KEYS.address]: hotWalletAddress.trim() } : {}),
        };
        break;
      case 'plain_note':
        fields.push({ key: NOTE_CONTENT_KEY, value: noteContent, type: 'text', sensitive: false });
        meta = { ...meta, [NOTE_CONTENT_KEY]: noteContent };
        break;
      case 'apikey':
        fields.push({ key: APIKEY_FIELD_KEYS.key, value: apiKeyName, type: 'text', sensitive: false });
        fields.push({ key: APIKEY_FIELD_KEYS.value, value: apiKeyValue, type: 'secret', sensitive: true });
        meta = { ...meta, [APIKEY_FIELD_KEYS.key]: apiKeyName };
        break;
      case 'custom':
        fields.push({ key: resolvedCustomFieldKey, value: customFieldValue, type: 'secret', sensitive: true });
        meta = { ...meta, primaryKey: resolvedCustomFieldKey };
        break;
      case 'oauth2': {
        const expiresAtSeconds = Number.parseInt(oauth2ExpiresAt, 10);
        fields.push({ key: OAUTH2_FIELD_KEYS.accessToken, value: oauth2AccessToken, type: 'secret', sensitive: true });
        fields.push({ key: OAUTH2_FIELD_KEYS.refreshToken, value: oauth2RefreshToken, type: 'secret', sensitive: true });
        fields.push({ key: OAUTH2_FIELD_KEYS.clientId, value: oauth2ClientId, type: 'secret', sensitive: true });
        fields.push({ key: OAUTH2_FIELD_KEYS.clientSecret, value: oauth2ClientSecret, type: 'secret', sensitive: true });
        meta = {
          ...meta,
          [OAUTH2_FIELD_KEYS.tokenEndpoint]: oauth2TokenEndpoint,
          [OAUTH2_FIELD_KEYS.scopes]: oauth2Scopes,
          [OAUTH2_FIELD_KEYS.authMethod]: oauth2AuthMethod,
          [OAUTH2_FIELD_KEYS.expiresAt]: Number.isFinite(expiresAtSeconds) ? expiresAtSeconds : null,
        };
        break;
      }

      case 'ssh': {
        const hosts = sshHostsInput
          .split(/\n|,/)
          .map((host) => host.trim())
          .filter(Boolean);
        fields.push({ key: SSH_FIELD_KEYS.privateKey, value: sshPrivateKey, type: 'secret', sensitive: true });
        if (sshPassphrase.trim()) fields.push({ key: SSH_FIELD_KEYS.passphrase, value: sshPassphrase, type: 'secret', sensitive: true });
        if (sshPublicKey.trim()) fields.push({ key: SSH_FIELD_KEYS.publicKey, value: sshPublicKey, type: 'text', sensitive: false });
        meta = {
          ...meta,
          [SSH_FIELD_KEYS.publicKey]: sshPublicKey,
          [SSH_FIELD_KEYS.hosts]: hosts,
          [SSH_FIELD_KEYS.keyType]: sshKeyType || undefined,
        };
        break;
      }
      case 'gpg':
        fields.push({ key: GPG_FIELD_KEYS.privateKey, value: gpgPrivateKey, type: 'secret', sensitive: true });
        if (gpgPublicKey.trim()) fields.push({ key: GPG_FIELD_KEYS.publicKey, value: gpgPublicKey, type: 'text', sensitive: false });
        meta = {
          ...meta,
          [GPG_FIELD_KEYS.publicKey]: gpgPublicKey,
          [GPG_FIELD_KEYS.keyId]: gpgKeyId,
          [GPG_FIELD_KEYS.uidEmail]: gpgUidEmail,
          [GPG_FIELD_KEYS.expiresAt]: gpgExpiresAt || undefined,
        };
        break;
    }

    if (walletLink) {
      meta = { ...meta, walletLink };
    }

    return { agentId, type, name: resolvedName, fields, meta };
  };

  const handleSave = async () => {
    const canDeriveName = canDeriveNameFromInputs({
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
    });
    if (type === 'login' && !isEdit && !password.trim()) {
      setError('Password is required for login');
      return;
    }
    if (type === 'login' && isEdit && totpIntent === 'replace' && !totpSecret.trim()) {
      setError('TOTP replace requires a valid secret or setup link');
      return;
    }
    if (type === 'plain_note' && !noteContent.trim()) {
      setError('Content is required for plain note');
      return;
    }
    if (type === 'apikey' && (!apiKeyName.trim() || !apiKeyValue.trim())) {
      setError('Key and value are required for API key');
      return;
    }
    if (type === 'custom' && (!customFieldKey.trim() || !customFieldValue.trim())) {
      setError('Primary key and value are required for custom type');
      return;
    }
    if (type === 'sso' && !ssoWebsite.trim()) {
      setError('Website is required for SSO login');
      return;
    }
    if (type === 'sso' && !ssoProvider.trim()) {
      setError('Provider is required for SSO login');
      return;
    }
    if (type === 'ssh' && !sshPrivateKey.trim() && !isEdit) {
      setError('SSH private key is required');
      return;
    }
    if (type === 'gpg' && !gpgPrivateKey.trim() && !isEdit) {
      setError('GPG private key is required');
      return;
    }
    if (type === 'oauth2') {
      if (!oauth2TokenEndpoint.trim()) {
        setError('OAuth2 requires a token endpoint. Add a valid token endpoint URL.');
        return;
      }

      const expiresAtNumber = Number.parseInt(oauth2ExpiresAt, 10);
      if (!Number.isFinite(expiresAtNumber) || expiresAtNumber <= 0) {
        setError('OAuth2 expiry is invalid. Enter a positive unix timestamp in seconds.');
        return;
      }
      if (!isEdit) {
        if (!oauth2AccessToken.trim()) {
          setError('OAuth2 requires an access token.');
          return;
        }
        if (!oauth2RefreshToken.trim()) {
          setError('OAuth2 requires a refresh token.');
          return;
        }
        if (!oauth2ClientId.trim()) {
          setError('OAuth2 requires a client ID.');
          return;
        }
        if (!oauth2ClientSecret.trim()) {
          setError('OAuth2 requires a client secret.');
          return;
        }
      }
    }
    if (!name.trim() && !canDeriveName) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);

    try {
      const payload = buildPayload();
      let savedCredentialId: string | undefined;

      if (isEdit) {
        // Only submit changed sensitive fields for edit.
        const editFields = payload.fields.filter((f) => !f.sensitive || !!dirtySensitiveFields[f.key]);
        await api.put(Api.Wallet, `/credentials/${editCredentialId}`, {
          ...payload,
          fields: editFields,
        });
        savedCredentialId = editCredentialId;
      } else {
        const createRes = await api.post<{ success: boolean; credential?: { id?: string } }>(Api.Wallet, '/credentials', payload);
        savedCredentialId = createRes?.credential?.id;
      }

      await onSaved(savedCredentialId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save credential');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!isOpen || isEdit || createStep !== 'form') return;

    const onShortcutSave = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (saving) return;
      if (!canShortcutSave()) return;
      event.preventDefault();
      event.stopPropagation();
      void handleSave();
    };

    window.addEventListener('keydown', onShortcutSave);
    return () => window.removeEventListener('keydown', onShortcutSave);
  }, [canShortcutSave, createStep, handleSave, isEdit, isOpen, saving]);

  const textareaClassName =
    'w-full h-24 bg-[var(--color-background-alt,#f4f4f5)] border border-[var(--color-border,#d4d4d8)] font-mono text-sm p-3 resize-none focus:border-[var(--color-border-focus,#0a0a0a)] outline-none text-[var(--color-text,#0a0a0a)] placeholder-[var(--color-text-muted,#6b7280)]';

  const selectedTypeLabel = TYPE_META[type]?.label || 'Credential';
  const primaryFieldKey = getCredentialPrimaryFieldKey(type);
  const primaryFieldSpec = getCredentialPrimaryFieldSpec(type);
  const primaryFieldLabel = primaryFieldSpec?.label || 'Primary Value';
  const createHeaderTitle = createStep === 'form' ? `Create ${selectedTypeLabel}` : 'Create';

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={isEdit ? 'Edit Credential' : createHeaderTitle}
        size="lg"
        headerActionPosition="left"
        headerAction={!isEdit && createStep === 'form' ? (
          <button
            type="button"
            data-testid="back-to-type-picker"
            onClick={() => setCreateStep('type')}
            className="inline-flex items-center justify-center w-6 h-6 text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
            aria-label="Back to type picker"
          >
            <ArrowLeft size={12} />
          </button>
        ) : undefined}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            {(!isEdit && createStep === 'type') ? null : (
              <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
                Save
              </Button>
            )}
          </div>
        }
      >
        {!isEdit && createStep === 'type' ? (
          <div className="space-y-4">
            <div data-testid="featured-types-section" className="space-y-2">
              <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
                Common
              </p>
              <ItemPicker
                ariaLabel="Common types"
                options={FEATURED_TYPE_ORDER.map((t) => {
                  const Icon = TYPE_META[t].icon;
                  return {
                    value: t,
                    label: TYPE_META[t].label,
                    description: TYPE_META[t].description,
                    icon: <Icon size={16} />,
                    quickActionLabel: `Quick create ${TYPE_META[t].label}`,
                    onQuickAction: () => {
                      setType(t);
                      setError(null);
                      setCreateStep('form');
                    },
                  };
                })}
                value={type}
                onChange={(val) => {
                  setType(val as FormType);
                  setError(null);
                  setCreateStep('form');
                }}
              />
            </div>

            <div data-testid="other-types-section" className="space-y-2">
              <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
                Other Types
              </p>
              <ItemPicker
                ariaLabel="Other types"
                options={REMAINING_TYPE_ORDER.map((t) => {
                  const Icon = TYPE_META[t].icon;
                  return {
                    value: t,
                    label: TYPE_META[t].label,
                    description: TYPE_META[t].description,
                    icon: <Icon size={16} />,
                    quickActionLabel: `Quick create ${TYPE_META[t].label}`,
                    onQuickAction: () => {
                      setType(t);
                      setError(null);
                      setCreateStep('form');
                    },
                  };
                })}
                value={type}
                onChange={(val) => {
                  setType(val as FormType);
                  setError(null);
                  setCreateStep('form');
                }}
              />
            </div>
          </div>
        ) : (
          <div data-testid="credential-form-layout" className="space-y-4 gap-4">
            <input
              ref={noteImportInputRef}
              type="file"
              accept={NOTE_IMPORT_ACCEPT}
              onChange={handleMarkdownFileInputChange}
              className="hidden"
              data-testid="note-markdown-file-input"
            />
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
                  Type: {selectedTypeLabel}
                </span>
              </div>
            </div>

            {/* Type-specific fields */}
            {type === 'login' && (
              <div className="space-y-3">
                <TextInput
                  label="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onFocus={() => setShowUsernameSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowUsernameSuggestions(false), 50)}
                  placeholder="user@example.com"
                  list="login-username-suggestions"
                />
                {showUsernameSuggestions && usernameSuggestions.length > 0 && (
                  <datalist id="login-username-suggestions">
                    {usernameSuggestions.map((suggestion) => (
                      <option key={suggestion} value={suggestion} />
                    ))}
                  </datalist>
                )}

                <TextInput
                  label="Website"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com"
                />

                <div className="relative">
                  <TextInput
                    label="Password"
                    type={isSensitiveFieldVisible(LOGIN_FIELD_KEYS.password) ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (isEdit) markSensitiveDirty(LOGIN_FIELD_KEYS.password);
                    }}
                    onFocus={() => setShowPasswordActions(true)}
                    onClick={() => setShowPasswordActions(true)}
                    onBlur={(e) => {
                      const nextTarget = e.relatedTarget as Node | null;
                      if (nextTarget && passwordActionsRef.current?.contains(nextTarget)) return;
                      setShowPasswordActions(false);
                    }}
                    placeholder={isEdit ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : ''}
                    rightElement={(
                      <button
                        type="button"
                        onClick={() => { void toggleSensitiveFieldVisibility(LOGIN_FIELD_KEYS.password); }}
                        aria-label={isSensitiveFieldVisible(LOGIN_FIELD_KEYS.password) ? 'Hide Password' : 'Reveal Password'}
                        className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
                      >
                        {revealingField === LOGIN_FIELD_KEYS.password ? <Loader2 size={11} className="animate-spin" /> : <Eye size={12} />}
                      </button>
                    )}
                  />
                  {showPasswordActions && (
                    <div
                      ref={passwordActionsRef}
                      className="absolute right-0 top-full mt-1 z-20 min-w-[13rem] border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)] shadow-[2px_2px_0_rgba(10,10,10,0.08)]"
                    >
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setShowPasswordGen(true);
                          setShowPasswordActions(false);
                        }}
                        className="w-full text-left px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)]"
                      >
                        Generate New Password
                      </button>
                    </div>
                  )}
                </div>

                {showGlobalAdvanced && (
                  <div className="space-y-3 border border-[var(--color-border,#d4d4d8)] p-3 bg-[var(--color-background-alt,#f4f4f5)]">
                    <div>
                      <div className="flex items-center justify-between mb-1.5 px-1">
                        <label className="block font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
                          Notes
                        </label>
                        {isEdit && (
                          <button
                            type="button"
                            onClick={() => { void handleRevealField(LOGIN_FIELD_KEYS.notes); }}
                            aria-label="Reveal Notes"
                            className="font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors inline-flex items-center gap-1"
                          >
                            {revealingField === LOGIN_FIELD_KEYS.notes ? <Loader2 size={9} className="animate-spin" /> : <Eye size={9} />}
                            Reveal
                          </button>
                        )}
                      </div>
                      <textarea
                        className={textareaClassName}
                        value={loginNotes}
                        onChange={(e) => {
                          setLoginNotes(e.target.value);
                          if (isEdit) markSensitiveDirty(LOGIN_FIELD_KEYS.notes);
                        }}
                        placeholder={isEdit ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : ''}
                      />
                    </div>
                    <TotpSetupPanel
                      isEdit={isEdit}
                      hasExistingTotp={hasExistingTotp}
                      onIntentChange={(intent) => {
                        setTotpIntent(intent);
                        if (isEdit && intent === 'remove') {
                          markSensitiveDirty(LOGIN_FIELD_KEYS.totp);
                        }
                      }}
                      onSecretChange={(secret, markDirty) => {
                        setTotpSecret(secret);
                        if (isEdit) {
                          if (markDirty) {
                            markSensitiveDirty(LOGIN_FIELD_KEYS.totp);
                            if (secret.trim()) {
                              setTotpIntent('replace');
                            }
                          } else if (totpIntent !== 'remove') {
                            setTotpIntent(hasExistingTotp ? 'keep' : 'replace');
                          }
                        }
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            {type === 'card' && (
              <div className="space-y-3">
                <TextInput
                  label="Cardholder"
                  value={cardholder}
                  onChange={(e) => setCardholder(e.target.value)}
                  placeholder="John Doe"
                />
                <TextInput
                  label="Card Number"
                  value={cardNumber}
                  onChange={(e) => {
                    const nextValue = e.target.value;
                    setCardNumber(nextValue);
                    setCardLast4(nextValue.replace(/\D/g, '').slice(-4));
                    if (isEdit) markSensitiveDirty(CARD_FIELD_KEYS.number);
                  }}
                  placeholder={isEdit ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : ''}
                />
                <div className="flex gap-3">
                  <div className="flex-1">
                    <TextInput
                      label="Expiry"
                      value={expiry}
                      onChange={(e) => {
                        setExpiry(e.target.value);
                        if (isEdit) markSensitiveDirty(CARD_FIELD_KEYS.expiry);
                      }}
                      placeholder="MM/YY"
                    />
                  </div>
                  <div className="flex-1">
                    <TextInput
                      label="CVV"
                      type="password"
                      value={cvv}
                      onChange={(e) => {
                        setCvv(e.target.value);
                        if (isEdit) markSensitiveDirty(CARD_FIELD_KEYS.cvv);
                      }}
                      placeholder={isEdit ? '\u2022\u2022\u2022\u2022' : ''}
                    />
                  </div>
                </div>
                {showGlobalAdvanced && (
                  <div className="space-y-3 border border-[var(--color-border,#d4d4d8)] p-3 bg-[var(--color-background-alt,#f4f4f5)]">
                    <FilterDropdown options={BRAND_OPTIONS} value={brand} onChange={setBrand} label="Brand" />
                    <TextInput label="Billing ZIP" value={billingZip} onChange={(e) => setBillingZip(e.target.value)} placeholder="12345" />
                  </div>
                )}
              </div>
            )}

            {type === 'sso' && (
              <div className="space-y-3">
                <TextInput
                  label="Website"
                  value={ssoWebsite}
                  onChange={(e) => setSsoWebsite(e.target.value)}
                  placeholder="https://example.com"
                />
                <div className="space-y-1">
                  <label className="block font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
                    Provider
                  </label>
                  <div data-testid="sso-provider-select">
                    <ItemPicker
                      ariaLabel="SSO Provider"
                      options={SSO_PROVIDER_OPTIONS.map((providerOption) => ({
                        value: providerOption.value,
                        label: providerOption.label,
                        description: `Sign in with ${providerOption.label}`,
                        icon: providerOption.icon,
                      }))}
                      value={ssoProvider}
                      onChange={(val) => setSsoProvider(String(val))}
                    />
                  </div>
                </div>
                {showGlobalAdvanced && (
                  <div className="space-y-3 border border-[var(--color-border,#d4d4d8)] p-3 bg-[var(--color-background-alt,#f4f4f5)]">
                    <TextInput
                      label="Identifier (email/phone/username)"
                      value={ssoIdentifier}
                      onChange={(e) => setSsoIdentifier(e.target.value)}
                      placeholder="alice@example.com"
                    />
                  </div>
                )}
              </div>
            )}

            {type === 'note' && (
              <div>
                <div className="flex items-center justify-between mb-1.5 px-1">
                  <label className="block font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
                    Content
                  </label>
                  {isEdit && (
                    <button
                      type="button"
                      onClick={() => { void handleRevealField(NOTE_CONTENT_KEY); }}
                      aria-label="Reveal Content"
                      className="font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors inline-flex items-center gap-1"
                    >
                      {revealingField === NOTE_CONTENT_KEY ? <Loader2 size={9} className="animate-spin" /> : <Eye size={9} />}
                      Reveal
                    </button>
                  )}
                </div>
                <div className="mb-2 px-1">
                  <div className="flex items-center justify-between gap-2" data-testid="note-editor-toolbar">
                    <div className="inline-flex border border-[var(--color-border,#d4d4d8)]">
                      <button
                        type="button"
                        data-testid="note-mode-write"
                        onClick={() => setNoteEditorMode('write')}
                        className={`px-2 py-1 font-mono text-[8px] uppercase tracking-widest transition-colors ${noteEditorMode === 'write' ? 'bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)]' : 'text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)]'}`}
                      >
                        Write
                      </button>
                      <button
                        type="button"
                        data-testid="note-mode-preview"
                        onClick={() => setNoteEditorMode('preview')}
                        className={`px-2 py-1 font-mono text-[8px] uppercase tracking-widest transition-colors ${noteEditorMode === 'preview' ? 'bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)]' : 'text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)]'}`}
                      >
                        Preview
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={openMarkdownFilePicker}
                      className="font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors inline-flex items-center gap-1"
                      data-testid="note-import-markdown-button"
                    >
                      <Upload size={9} />
                      Import .md/.txt
                    </button>
                  </div>
                </div>
                {noteEditorMode === 'preview' ? (
                  <div
                    data-testid="note-markdown-preview"
                    className="w-full h-48 overflow-y-auto bg-[var(--color-background-alt,#f4f4f5)] border border-[var(--color-border,#d4d4d8)] p-3"
                  >
                    {notePreviewHtml ? (
                      <div className="prose-mono max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" dangerouslySetInnerHTML={{ __html: notePreviewHtml }} />
                    ) : (
                      <span className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">Nothing to preview yet.</span>
                    )}
                  </div>
                ) : (
                  <textarea
                    className={textareaClassName.replace('h-24', 'h-48')}
                    value={noteContent}
                    onChange={(e) => {
                      setNoteContent(e.target.value);
                      if (isEdit) markSensitiveDirty(NOTE_CONTENT_KEY);
                    }}
                    placeholder={isEdit ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : ''}
                  />
                )}
              </div>
            )}

            {type === 'plain_note' && (
              <div className="space-y-3">
                <p className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">
                  Plain Note stores readable content in metadata (not encrypted).
                </p>
                <div>
                  <div className="flex items-center justify-between mb-1.5 px-1">
                    <label className="block font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
                      Content
                    </label>
                  </div>
                  <div className="mb-2">
                    <div className="flex items-center justify-between gap-2" data-testid="plain-note-editor-toolbar">
                      <div className="inline-flex border border-[var(--color-border,#d4d4d8)]">
                        <button
                          type="button"
                          data-testid="plain-note-mode-write"
                          onClick={() => setNoteEditorMode('write')}
                          className={`px-2 py-1 font-mono text-[8px] uppercase tracking-widest transition-colors ${noteEditorMode === 'write' ? 'bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)]' : 'text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)]'}`}
                        >
                          Write
                        </button>
                        <button
                          type="button"
                          data-testid="plain-note-mode-preview"
                          onClick={() => setNoteEditorMode('preview')}
                          className={`px-2 py-1 font-mono text-[8px] uppercase tracking-widest transition-colors ${noteEditorMode === 'preview' ? 'bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)]' : 'text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)]'}`}
                        >
                          Preview
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={openMarkdownFilePicker}
                        className="font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors inline-flex items-center gap-1"
                        data-testid="plain-note-import-markdown-button"
                      >
                        <Upload size={9} />
                        Import .md/.txt
                      </button>
                    </div>
                  </div>
                  {noteEditorMode === 'preview' ? (
                    <div
                      data-testid="plain-note-markdown-preview"
                      className="w-full h-48 overflow-y-auto bg-[var(--color-background-alt,#f4f4f5)] border border-[var(--color-border,#d4d4d8)] p-3"
                    >
                      {notePreviewHtml ? (
                        <div className="prose-mono max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" dangerouslySetInnerHTML={{ __html: notePreviewHtml }} />
                      ) : (
                        <span className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">Nothing to preview yet.</span>
                      )}
                    </div>
                  ) : (
                    <textarea
                      className={textareaClassName.replace('h-24', 'h-48')}
                      value={noteContent}
                      onChange={(e) => setNoteContent(e.target.value)}
                      placeholder=""
                    />
                  )}
                </div>
              </div>
            )}

            {type === 'hot_wallet' && (
              <div className="space-y-3">
                <p className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">
                  Generates a hot wallet via backend wallet creation logic and stores the private key as encrypted primary secret.
                </p>
                <div className="space-y-1">
                  <label className="block font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
                    Chain
                  </label>
                  <div data-testid="hot-wallet-chain-select">
                    <ItemPicker
                      ariaLabel="Chain"
                      options={[
                        { value: 'base', label: 'Base / EVM', description: 'EVM-compatible chains' },
                        { value: 'solana', label: 'Solana', description: 'Solana network wallets' },
                      ]}
                      value={hotWalletChain}
                      onChange={(val) => setHotWalletChain(val as 'base' | 'solana')}
                    />
                  </div>
                </div>
                {isEdit && (
                  <TextInput
                    label="Address"
                    value={hotWalletAddress}
                    onChange={(e) => setHotWalletAddress(e.target.value)}
                    placeholder="Generated wallet address"
                  />
                )}
              </div>
            )}

            {type === 'apikey' && (
              <div className="space-y-3">
                <p className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">
                  Minimal flow: key name + key value. If Name is blank, key name becomes the credential title.
                </p>
                <TextInput
                  label="Key"
                  value={apiKeyName}
                  onChange={(e) => setApiKeyName(e.target.value)}
                  placeholder="Service key name"
                />
                <TextInput
                  label="Value"
                  type={isSensitiveFieldVisible(APIKEY_FIELD_KEYS.value) ? 'text' : 'password'}
                  value={apiKeyValue}
                  onChange={(e) => {
                    setApiKeyValue(e.target.value);
                    if (isEdit) markSensitiveDirty(APIKEY_FIELD_KEYS.value);
                  }}
                  placeholder={isEdit ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : ''}
                  rightElement={(
                    <button
                      type="button"
                      onClick={() => { void toggleSensitiveFieldVisibility(APIKEY_FIELD_KEYS.value); }}
                      aria-label={isSensitiveFieldVisible(APIKEY_FIELD_KEYS.value) ? 'Hide Value' : 'Reveal Value'}
                      className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
                    >
                      {revealingField === APIKEY_FIELD_KEYS.value ? <Loader2 size={11} className="animate-spin" /> : <Eye size={12} />}
                    </button>
                  )}
                />
              </div>
            )}

            {type === 'custom' && (
              <div className="space-y-3">
                <p className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">
                  Canonical primary key: {primaryFieldKey}
                </p>
                <TextInput
                  label="Primary Key"
                  value={customFieldKey}
                  onChange={(e) => setCustomFieldKey(e.target.value)}
                  placeholder="value"
                />
                <TextInput
                  label={primaryFieldLabel}
                  type={isSensitiveFieldVisible(CREDENTIAL_FIELD_KEYS.custom.value) ? 'text' : 'password'}
                  value={customFieldValue}
                  onChange={(e) => setCustomFieldValue(e.target.value)}
                  placeholder={isEdit ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : ''}
                  rightElement={(
                    <button
                      type="button"
                      onClick={() => { void toggleSensitiveFieldVisibility(CREDENTIAL_FIELD_KEYS.custom.value); }}
                      aria-label={isSensitiveFieldVisible(CREDENTIAL_FIELD_KEYS.custom.value) ? 'Hide Value' : 'Reveal Value'}
                      className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
                    >
                      {revealingField === CREDENTIAL_FIELD_KEYS.custom.value ? <Loader2 size={11} className="animate-spin" /> : <Eye size={12} />}
                    </button>
                  )}
                />
              </div>
            )}

            {type === 'oauth2' && (
              <div className="space-y-3">
                <TextInput label="Token Endpoint" value={oauth2TokenEndpoint} onChange={(e) => setOauth2TokenEndpoint(e.target.value)} placeholder="https://accounts.google.com/o/oauth2/token" />
                <TextInput
                  label="Access Token"
                  type="password"
                  value={oauth2AccessToken}
                  onChange={(e) => {
                    setOauth2AccessToken(e.target.value);
                    if (isEdit) markSensitiveDirty(OAUTH2_FIELD_KEYS.accessToken);
                  }}
                  placeholder={isEdit ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : 'Optional — will be fetched on first use'}
                />
                <TextInput label="Expires At (unix seconds)" type="text" value={oauth2ExpiresAt} onChange={(e) => setOauth2ExpiresAt(e.target.value)} placeholder={String(Math.floor(Date.now() / 1000) + 60 * 60)} />

                {showGlobalAdvanced && (
                  <div className="space-y-3 border border-[var(--color-border,#d4d4d8)] p-3 bg-[var(--color-background-alt,#f4f4f5)]">
                    <TextInput
                      label="Client ID"
                      value={oauth2ClientId}
                      onChange={(e) => {
                        setOauth2ClientId(e.target.value);
                        if (isEdit) markSensitiveDirty(OAUTH2_FIELD_KEYS.clientId);
                      }}
                      placeholder="your-client-id"
                    />
                    <TextInput
                      label="Client Secret"
                      type="password"
                      value={oauth2ClientSecret}
                      onChange={(e) => {
                        setOauth2ClientSecret(e.target.value);
                        if (isEdit) markSensitiveDirty(OAUTH2_FIELD_KEYS.clientSecret);
                      }}
                      placeholder={isEdit ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : ''}
                    />
                    <TextInput
                      label="Refresh Token"
                      type="password"
                      value={oauth2RefreshToken}
                      onChange={(e) => {
                        setOauth2RefreshToken(e.target.value);
                        if (isEdit) markSensitiveDirty(OAUTH2_FIELD_KEYS.refreshToken);
                      }}
                      placeholder={isEdit ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : ''}
                    />
                    <TextInput label="Scopes" value={oauth2Scopes} onChange={(e) => setOauth2Scopes(e.target.value)} placeholder="read write (space-separated)" />
                    <FilterDropdown
                      options={[
                        { value: 'client_secret_post', label: 'Client Secret (POST body)' },
                        { value: 'client_secret_basic', label: 'Client Secret (Basic Auth)' },
                      ]}
                      value={oauth2AuthMethod}
                      onChange={setOauth2AuthMethod}
                      label="Auth Method"
                    />
                  </div>
                )}
              </div>
            )}


            {type === 'ssh' && (
              <div className="space-y-3">
                <TextInput label="Public Key (optional)" value={sshPublicKey} onChange={(e) => setSshPublicKey(e.target.value)} placeholder="ssh-ed25519 AAAA..." />
                <div>
                  <label className="block font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">Private Key</label>
                  <textarea className={textareaClassName.replace('h-24', 'h-40')} value={sshPrivateKey} onChange={(e) => { setSshPrivateKey(e.target.value); if (isEdit) markSensitiveDirty(SSH_FIELD_KEYS.privateKey); }} placeholder={isEdit ? '••••••••' : '-----BEGIN OPENSSH PRIVATE KEY-----'} />
                </div>
                <TextInput label="Passphrase (optional)" type="password" value={sshPassphrase} onChange={(e) => { setSshPassphrase(e.target.value); if (isEdit) markSensitiveDirty(SSH_FIELD_KEYS.passphrase); }} />
                <div>
                  <label className="block font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">Associated Hosts (comma or newline)</label>
                  <textarea className={textareaClassName} value={sshHostsInput} onChange={(e) => setSshHostsInput(e.target.value)} placeholder="github.com
prod.example.com" />
                </div>
              </div>
            )}

            {type === 'gpg' && (
              <div className="space-y-3">
                <div>
                  <label className="block font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">Private Key (armored)</label>
                  <textarea className={textareaClassName.replace('h-24', 'h-40')} value={gpgPrivateKey} onChange={(e) => { setGpgPrivateKey(e.target.value); if (isEdit) markSensitiveDirty(GPG_FIELD_KEYS.privateKey); }} placeholder={isEdit ? '••••••••' : '-----BEGIN PGP PRIVATE KEY BLOCK-----'} />
                </div>
                <div>
                  <label className="block font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">Public Key (optional)</label>
                  <textarea className={textareaClassName} value={gpgPublicKey} onChange={(e) => setGpgPublicKey(e.target.value)} placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" />
                </div>
                <TextInput label="Key ID (optional)" value={gpgKeyId} onChange={(e) => setGpgKeyId(e.target.value)} />
                <TextInput label="UID Email (optional)" value={gpgUidEmail} onChange={(e) => setGpgUidEmail(e.target.value)} />
                <TextInput label="Expires At (optional)" value={gpgExpiresAt} onChange={(e) => setGpgExpiresAt(e.target.value)} placeholder="2027-01-01" />
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGlobalAdvanced((prev) => !prev)}
              className="font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] text-left"
            >
              {showGlobalAdvanced ? 'Hide Advanced' : 'Show Advanced'}
            </button>

            {showGlobalAdvanced && (
              <div className="space-y-4 border border-[var(--color-border,#d4d4d8)] p-3 bg-[var(--color-background-alt,#f4f4f5)]">
                {!isEdit && agentOptions.length > 0 && (
                  <FilterDropdown
                    options={agentOptions}
                    value={agentId}
                    onChange={setAgentId}
                    label="Agent"
                  />
                )}

                {/* Tags */}
                <div>
                  <TextInput
                    label="Tags"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={handleTagKeyDown}
                    placeholder="Add tag and press Enter"
                  />
                  {visibleTagSuggestions.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {visibleTagSuggestions.map((suggestedTag) => (
                        <button
                          key={suggestedTag}
                          type="button"
                          onClick={() => {
                            if (!tags.includes(suggestedTag)) setTags([...tags, suggestedTag]);
                            setTagInput('');
                          }}
                          className="font-mono text-[9px] px-2 py-0.5 border border-[var(--color-border,#d4d4d8)] hover:border-[var(--color-border-focus,#0a0a0a)]"
                        >
                          + {suggestedTag}
                        </button>
                      ))}
                    </div>
                  )}
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 bg-[var(--color-accent,#ccff00)]/10 text-[var(--color-text,#0a0a0a)] text-[9px] font-mono px-2 py-0.5"
                        >
                          {tag}
                          <button
                            type="button"
                            onClick={() => removeTag(tag)}
                            className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] ml-0.5"
                          >
                            x
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <Toggle size="sm" checked={favorite} onChange={setFavorite} label="Favorite" />
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="font-mono text-[10px] text-[var(--color-danger,#ef4444)] bg-[var(--color-danger,#ef4444)]/5 border border-[var(--color-danger,#ef4444)]/20 px-3 py-2">
                {error}
              </div>
            )}


          </div>
        )}
      </Modal>

      {/* Password Generator */}
      <PasswordGenerator
        isOpen={showPasswordGen}
        onClose={() => setShowPasswordGen(false)}
        onUse={(pw) => {
          setPassword(pw);
          if (isEdit) markSensitiveDirty(LOGIN_FIELD_KEYS.password);
          setShowPasswordGen(false);
        }}
      />
    </>
  );
};
