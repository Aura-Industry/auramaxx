'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Shield,
  ShieldCheck,
  BadgeCheck,
  Clock,
  Loader2,
  ExternalLink,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Plus,
  User,
} from 'lucide-react';
import { api, Api } from '@/lib/api';
import { Button, TextInput } from '@/components/design-system';
import { ViewShell } from '@/components/layout/ViewShell';
import { AgentPfp, type AgentPickerProfile } from '@/components/AgentPicker';
import { CreateAgentModal } from '@/components/CreateAgentModal';

// ─── Types ───────────────────────────────────────────────────────────

type CredentialTab = 'credentials' | 'profile';

interface AgentInfo {
  id: string;
  name?: string;
  address: string;
  solanaAddress?: string;
  isUnlocked: boolean;
  isPrimary: boolean;
  mode?: string;
  parentAgentId?: string;
}

interface HubStatus {
  agentId: string;
  auraId: number | null;
  publicKeyHex: string | null;
  registered: boolean;
  hasPublicKey: boolean;
}

interface CredentialType {
  slug: string;
  name: string;
  description?: string;
  verifierKey: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

interface VerifiedCredential {
  id: number;
  credentialType: string;
  claimedIdentity: string;
  ownerAuraId: number;
  issuerAuraId: number;
  attestationHash: string;
  verifiedAt: string;
  revoked: boolean;
}

interface CredentialRequest {
  requestId: string;
  auraId: number;
  credentialType: string;
  claimedIdentity: string;
  proofUrl?: string;
  status: string;
  statusDetail?: string;
  attempts: number;
  createdAt: string;
  verifiedAt?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusBadge(status: string) {
  switch (status) {
    case 'pending':
      return { icon: Clock, color: '#f59e0b', label: 'Pending' };
    case 'verifying':
      return { icon: Loader2, color: '#6366f1', label: 'Verifying' };
    case 'verified':
      return { icon: CheckCircle2, color: '#22c55e', label: 'Verified' };
    case 'rejected':
      return { icon: XCircle, color: '#ef4444', label: 'Rejected' };
    case 'failed':
      return { icon: AlertCircle, color: '#ef4444', label: 'Failed' };
    default:
      return { icon: Clock, color: '#6b7280', label: status };
  }
}

// ─── Shared styles ──────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--color-border, #d4d4d8)',
  borderRadius: '8px',
  padding: '12px 16px',
  background: 'var(--color-surface, #f4f4f2)',
  marginBottom: '8px',
};

const mutedText: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--color-text-muted, #6b7280)',
};

const accentText: React.CSSProperties = {
  fontWeight: 600,
  fontFamily: 'var(--font-mono, monospace)',
  color: 'var(--color-accent, #6366f1)',
};

// ─── Verification Wizard ─────────────────────────────────────────────

function VerificationWizard({
  credType,
  agentId,
  onComplete,
  onCancel,
}: {
  credType: CredentialType;
  agentId: string;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<'post' | 'verify' | 'polling'>('post');
  const [postUrl, setPostUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('pending');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [sigLoading, setSigLoading] = useState(true);

  // Fetch signed proof on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.post<{ ok: boolean; signature: string }>(
          Api.Wallet,
          '/verified-credentials/sign-proof',
          { agentId },
        );
        if (!cancelled && res.ok) setSignature(res.signature);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          setError(`Failed to generate signature: ${msg}`);
        }
      }
      if (!cancelled) setSigLoading(false);
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  useEffect(() => {
    if (!requestId || step !== 'polling') return;

    const poll = async () => {
      try {
        const res = await api.get<{ ok: boolean; request: CredentialRequest }>(
          Api.Wallet,
          `/verified-credentials/request/${requestId}`,
        );
        if (res.ok && res.request) {
          setStatus(res.request.status);
          setStatusDetail(res.request.statusDetail ?? null);
          if (res.request.status === 'verified' || res.request.status === 'rejected' || res.request.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            if (res.request.status === 'verified') {
              setTimeout(onComplete, 1500);
            }
          }
        }
      } catch { /* ignore polling errors */ }
    };

    poll();
    pollRef.current = setInterval(poll, 5_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [requestId, step, onComplete]);

  const handleSubmit = useCallback(async () => {
    const url = postUrl.trim();
    if (!url) return;
    // Extract username from X post URL: https://x.com/{username}/status/{id}
    const urlMatch = url.match(/(?:x\.com|twitter\.com)\/([^/]+)\/status\//);
    if (!urlMatch) {
      setError('Invalid X post URL');
      return;
    }
    const extractedHandle = urlMatch[1];
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<{ ok: boolean; request?: CredentialRequest; error?: string; requestId?: string }>(
        Api.Wallet,
        '/verified-credentials/request',
        {
          agentId,
          credentialTypeSlug: credType.slug,
          claimedIdentity: extractedHandle,
          proofUrl: url,
        },
      );
      if (res.ok && res.request) {
        setRequestId(res.request.requestId);
        setStep('polling');
      } else {
        setError(res.error ?? 'Failed to submit verification request');
        if (res.requestId) {
          setRequestId(res.requestId);
          setStep('polling');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  }, [agentId, credType.slug, postUrl]);

  if (step === 'post' || step === 'verify') {
    const tweetText = signature
      ? `\u25E5\u25E3 A U R A \u25E5\u25E3\n\u25E5\u25E3 M A X X \u25E5\u25E3\n\nVerifying via @npxauramaxx\n\n\u258C\u258C\u2590\u258C\u2590\u2590\u258C ATTESTATION \u2590\u258C\u2590\u2590\u258C\u2590\u258C\u258C\n${signature}`
      : '';
    const tweetUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

    const openTweetWindow = () => {
      window.open(tweetUrl, '_blank', 'width=550,height=420,noopener,noreferrer');
      setStep('verify');
    };

    return (
      <div style={cardStyle}>
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck size={16} className="text-[var(--color-accent,#6366f1)]" />
          <span className="font-mono text-sm font-semibold">Verify {credType.name}</span>
        </div>
        <div className="mb-4">
          <p className="text-[13px] mb-3 leading-relaxed text-[var(--color-text,#0a0a0a)]">
            {step === 'post'
              ? 'Post a signed message on X to prove you own this agent:'
              : 'Paste the link to your post:'}
          </p>
          {sigLoading ? (
            <div className="flex items-center gap-2 p-3">
              <Loader2 size={14} className="animate-spin text-[var(--color-text-muted,#6b7280)]" />
              <span className="font-mono text-xs text-[var(--color-text-muted,#6b7280)]">Generating signature...</span>
            </div>
          ) : !signature ? (
            <div className="text-xs text-[var(--color-danger,#ef4444)]">
              {error ?? 'Failed to generate signature'}
            </div>
          ) : null}
        </div>
        {step === 'verify' && (
          <div className="mb-3">
            <TextInput
              label="Post Link"
              compact
              value={postUrl}
              onChange={(e) => setPostUrl(e.target.value)}
              placeholder="https://x.com/username/status/..."
            />
          </div>
        )}
        {error && step === 'verify' && <div className="mb-2 font-mono text-xs text-[var(--color-danger,#ef4444)]">{error}</div>}
        <div className="flex gap-2">
          {step === 'post' ? (
            <Button
              variant="primary"
              size="sm"
              onClick={openTweetWindow}
              disabled={!signature}
              icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>}
            >
              POST
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={submitting || !postUrl.trim()}
              loading={submitting}
            >
              VERIFY
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onCancel}>
            CANCEL
          </Button>
        </div>
      </div>
    );
  }

  const badge = statusBadge(status);
  const StatusIcon = badge.icon;
  return (
    <div style={cardStyle}>
      <div className="flex items-center gap-2 mb-3">
        <StatusIcon size={16} style={{ color: badge.color }} className={status === 'verifying' ? 'animate-spin' : ''} />
        <span className="font-mono text-sm font-semibold">{badge.label}</span>
      </div>
      <p className="text-[13px] text-[var(--color-text,#0a0a0a)] mb-2">
        {status === 'pending' && 'Your verification request is queued...'}
        {status === 'verifying' && 'Hub is verifying your X post...'}
        {status === 'verified' && 'Your X account has been verified!'}
        {status === 'rejected' && `Verification rejected: ${statusDetail ?? 'Unknown reason'}`}
        {status === 'failed' && `Verification failed: ${statusDetail ?? 'Unknown error'}`}
      </p>
      {(status === 'rejected' || status === 'failed') && (
        <Button variant="ghost" size="sm" onClick={onCancel}>CLOSE</Button>
      )}
    </div>
  );
}

// ─── Request Card ────────────────────────────────────────────────────

function RequestCard({ req }: { req: CredentialRequest }) {
  const badge = statusBadge(req.status);
  const StatusIcon = badge.icon;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <StatusIcon size={14} style={{ color: badge.color }} className={req.status === 'verifying' ? 'animate-spin' : ''} />
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text, #0a0a0a)' }}>
            {req.credentialType === 'x_account' ? 'X Account' : req.credentialType}
          </span>
          <span style={{
            fontSize: '10px',
            fontWeight: 500,
            padding: '2px 6px',
            borderRadius: '4px',
            background: badge.color + '20',
            color: badge.color,
          }}>
            {badge.label}
          </span>
        </div>
        <span style={mutedText}>{formatDate(req.createdAt)}</span>
      </div>
      <div style={{ marginTop: '6px' }}>
        <span style={{ ...accentText, fontSize: '13px' }}>
          {req.credentialType === 'x_account' ? `@${req.claimedIdentity}` : req.claimedIdentity}
        </span>
      </div>
      {req.statusDetail && (
        <div style={{ marginTop: '6px', fontSize: '11px', color: '#ef4444' }}>
          {req.statusDetail}
        </div>
      )}
      {req.proofUrl && (
        <div style={{ marginTop: '6px' }}>
          <a
            href={req.proofUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: '11px', color: 'var(--color-accent, #6366f1)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            <ExternalLink size={10} /> View proof
          </a>
        </div>
      )}
    </div>
  );
}

// ─── Profile Editor ──────────────────────────────────────────────────

interface ProfileField {
  key: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
}

const PROFILE_FIELDS: ProfileField[] = [
  { key: 'handle', label: 'Handle', placeholder: '@myhandle' },
  { key: 'display_name', label: 'Display Name', placeholder: 'My Display Name' },
  { key: 'bio', label: 'Bio', placeholder: 'Tell the world about yourself...', multiline: true },
];

const SPRITE_OPTIONS = Array.from({ length: 10 }, (_, i) => `/agent${i + 1}.png`);

function ProfileEditor({ agentId }: { agentId: string }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [loading, setLoading] = useState(true);

  // Load current profile values from outbound messages
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await api.get<{ success: boolean; messages: { body: string; createdAt: string }[] }>(
          Api.Wallet,
          `/social/messages?agentId=${encodeURIComponent(agentId)}&type=user_data_add&limit=200`,
        );
        if (cancelled) return;
        const latest: Record<string, { value: string; date: string }> = {};
        for (const msg of res.messages ?? []) {
          try {
            const parsed = JSON.parse(msg.body) as { type?: string; value?: string };
            if (parsed.type && (!latest[parsed.type] || msg.createdAt > latest[parsed.type].date)) {
              latest[parsed.type] = { value: parsed.value ?? '', date: msg.createdAt };
            }
          } catch { /* skip malformed */ }
        }
        const vals: Record<string, string> = {};
        for (const f of PROFILE_FIELDS) {
          vals[f.key] = latest[f.key]?.value ?? '';
        }
        vals.pfp = latest['pfp']?.value || 'https://aurawallet.sh/agent7.png';
        // Backwards compat: if no pfp_is_sprite saved yet, detect from URL pattern
        vals.pfp_is_sprite = latest['pfp_is_sprite']?.value
          || (/\/agent\d+\.png$/.test(vals.pfp) ? 'true' : 'false');
        setValues(vals);
      } catch { /* silent */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  const handleSaveAll = useCallback(async () => {
    setSaving(true);
    setFeedback(null);
    const fields = [...PROFILE_FIELDS.map(f => f.key), 'pfp', 'pfp_is_sprite'];
    let allOk = true;
    for (const field of fields) {
      try {
        const res = await api.post<{ success?: boolean; error?: string }>(
          Api.Wallet,
          '/social/profile',
          { agentId, field, value: values[field] ?? '' },
        );
        if (!res.success) allOk = false;
      } catch {
        allOk = false;
      }
    }
    setFeedback(allOk ? { ok: true, msg: 'Saved' } : { ok: false, msg: 'Some fields failed to save' });
    setSaving(false);
    if (allOk) {
      setTimeout(() => setFeedback(null), 2500);
    }
  }, [agentId, values]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 size={14} className="animate-spin text-[var(--color-text-muted,#6b7280)]" />
        <span className="font-mono text-xs text-[var(--color-text-muted,#6b7280)]">Loading profile...</span>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <User size={16} className="text-[var(--color-accent,#6366f1)]" />
        <span className="font-mono text-sm font-semibold text-[var(--color-text,#0a0a0a)]">Edit Profile</span>
      </div>

      {/* Sprite picker */}
      <div className="mb-4">
        <span className="font-mono text-[length:var(--font-size-xs)] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] block mb-2">
          Profile Image
        </span>
        <div className="flex gap-2 flex-wrap items-end">
          {SPRITE_OPTIONS.map((src, i) => {
            const selected = values.pfp === `https://aurawallet.sh${src}`;
            return (
              <button
                key={src}
                type="button"
                onClick={() => setValues(v => ({ ...v, pfp: `https://aurawallet.sh${src}`, pfp_is_sprite: 'true' }))}
                className={`rounded-lg border-2 overflow-hidden transition-all ${
                  selected
                    ? 'border-[var(--color-accent,#6366f1)] shadow-[0_0_0_1px_var(--color-accent,#6366f1)]'
                    : 'border-transparent hover:border-[var(--color-text-muted,#6b7280)]'
                }`}
                style={{ padding: '4px 2px' }}
              >
                <div
                  className="yo-sprite"
                  style={{
                    backgroundImage: `url('${src}')`,
                    animation: `yo-sprite-frames 0.9s steps(1, end) infinite`,
                    animationDelay: `${i * -150}ms`,
                    width: '28px',
                    height: '40px',
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>

      {PROFILE_FIELDS.map((field) => (
        <div key={field.key} className="mb-3">
          {field.multiline ? (
            <div className="flex flex-col gap-1 w-full group">
              <label className="font-mono text-[length:var(--font-size-xs)] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] px-[var(--space-1)]">
                {field.label}
              </label>
              <textarea
                value={values[field.key] ?? ''}
                onChange={(e) => setValues(v => ({ ...v, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                rows={3}
                className="w-full h-auto bg-[var(--color-background-alt,#f4f4f5)] border border-[var(--color-border,#d4d4d8)] font-mono text-[length:var(--font-size-xs)] text-[var(--color-text,#0a0a0a)] placeholder-[var(--color-text-muted,#6b7280)] px-[var(--space-3)] py-2 resize-vertical outline-none hover:border-[var(--color-border-muted,#a1a1aa)] focus:border-[var(--color-border-focus,#0a0a0a)] focus:bg-[var(--color-surface,#ffffff)] transition-all"
              />
            </div>
          ) : (
            <TextInput
              label={field.label}
              compact
              value={values[field.key] ?? ''}
              onChange={(e) => setValues(v => ({ ...v, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
            />
          )}
        </div>
      ))}

      {feedback && (
        <div className={`mb-2 flex items-center gap-1 font-mono text-xs ${feedback.ok ? 'text-[#22c55e]' : 'text-[var(--color-danger,#ef4444)]'}`}>
          {feedback.ok ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
          {feedback.msg}
        </div>
      )}

      <Button variant="primary" size="sm" onClick={handleSaveAll} loading={saving}>
        SAVE
      </Button>
    </div>
  );
}

// ─── Credential Tabs ────────────────────────────────────────────────

const CREDENTIAL_TABS: { key: CredentialTab; label: string }[] = [
  { key: 'credentials', label: 'Credentials' },
  { key: 'profile', label: 'Profile' },
];

// ─── Main View ───────────────────────────────────────────────────────

export function VerificationView() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hubStatus, setHubStatus] = useState<HubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [hubLoading, setHubLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Credential state
  const [credentialTab, setCredentialTab] = useState<CredentialTab>('credentials');
  const [credLoading, setCredLoading] = useState(false);
  const [credentials, setCredentials] = useState<VerifiedCredential[]>([]);
  const [credentialTypes, setCredentialTypes] = useState<CredentialType[]>([]);
  const [requests, setRequests] = useState<CredentialRequest[]>([]);
  const [wizardType, setWizardType] = useState<CredentialType | null>(null);
  const [profiles, setProfiles] = useState<Record<string, AgentPickerProfile>>({});
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [approvedOnly, setApprovedOnly] = useState(false);

  const auraId = hubStatus?.auraId ?? null;
  const publicKeyHex = hubStatus?.publicKeyHex ?? null;
  // Fetch agent list
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ agents: AgentInfo[] }>(Api.Wallet, '/agents/credential');
        if (!cancelled) {
          setAgents(res.agents || []);
          if (res.agents?.length && !selectedId) {
            const primary = res.agents.find(a => a.isPrimary) ?? res.agents[0];
            setSelectedId(primary.id);
          }
        }
      } catch {
        if (!cancelled) setError('Failed to load agents');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshAgents = useCallback(async () => {
    try {
      const res = await api.get<{ agents: AgentInfo[] }>(Api.Wallet, '/agents/credential');
      setAgents(res.agents || []);
    } catch { /* silent */ }
  }, []);

  // Fetch hub status for selected agent
  useEffect(() => {
    if (!selectedId) {
      setHubStatus(null);
      return;
    }
    let cancelled = false;
    setHubLoading(true);
    (async () => {
      try {
        const res = await api.get<HubStatus>(Api.Wallet, `/agent-hub/${encodeURIComponent(selectedId)}/status`);
        if (!cancelled) setHubStatus(res);
      } catch {
        if (!cancelled) setHubStatus(null);
      } finally {
        if (!cancelled) setHubLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  // Fetch profile data for all agents
  const agentIds = useMemo(() => agents.map(a => a.id).sort().join(','), [agents]);

  useEffect(() => {
    let cancelled = false;
    const ids = agentIds.split(',').filter(Boolean);
    if (ids.length === 0) return;

    (async () => {
      const results: Record<string, AgentPickerProfile> = {};
      await Promise.allSettled(
        ids.map(async (id) => {
          try {
            const res = await api.get<{ success: boolean; messages: { body: string; createdAt: string }[] }>(
              Api.Wallet,
              `/social/messages?agentId=${encodeURIComponent(id)}&type=user_data_add&limit=200`,
            );
            if (cancelled) return;
            const latest: Record<string, { value: string; date: string }> = {};
            for (const msg of res.messages ?? []) {
              try {
                const parsed = JSON.parse(msg.body) as { type?: string; value?: string };
                if (parsed.type && (!latest[parsed.type] || msg.createdAt > latest[parsed.type].date)) {
                  latest[parsed.type] = { value: parsed.value ?? '', date: msg.createdAt };
                }
              } catch { /* skip */ }
            }
            const pfpVal = latest.pfp?.value;
            results[id] = {
              displayName: latest.display_name?.value || undefined,
              handle: latest.handle?.value || undefined,
              pfp: pfpVal || undefined,
              pfpIsSprite: latest.pfp_is_sprite?.value === 'true'
                || (!latest.pfp_is_sprite && /\/agent\d+\.png$/.test(pfpVal ?? '')),
            };
          } catch { /* skip */ }
        }),
      );
      if (!cancelled) setProfiles(results);
    })();
    return () => { cancelled = true; };
  }, [agentIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedAgent = agents.find(a => a.id === selectedId);
  const isUnlocked = selectedAgent?.isUnlocked ?? false;

  // Load all credential data when agent changes
  useEffect(() => {
    if (!selectedId || !isUnlocked) return;
    let cancelled = false;
    setCredLoading(true);
    setCredentials([]);
    setCredentialTypes([]);
    setRequests([]);

    (async () => {
      const [mineResult, typesResult, pendingResult] = await Promise.allSettled([
        api.get<{ ok: boolean; credentials: VerifiedCredential[] }>(
          Api.Wallet,
          `/verified-credentials/mine?agentId=${encodeURIComponent(selectedId)}`,
        ),
        api.get<{ ok: boolean; types: CredentialType[] }>(
          Api.Wallet,
          '/verified-credentials/types',
        ),
        api.get<{ ok: boolean; requests: CredentialRequest[] }>(
          Api.Wallet,
          `/verified-credentials/pending?agentId=${encodeURIComponent(selectedId)}`,
        ),
      ]);
      if (!cancelled) {
        if (mineResult.status === 'fulfilled') setCredentials(mineResult.value.credentials ?? []);
        if (typesResult.status === 'fulfilled') setCredentialTypes((typesResult.value.types ?? []).filter(t => t.enabled));
        if (pendingResult.status === 'fulfilled') setRequests(pendingResult.value.requests ?? []);
        setCredLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId, isUnlocked]);

  const refreshCredentials = useCallback(() => {
    if (!selectedId) return;
    setCredLoading(true);
    (async () => {
      const [mineResult, pendingResult] = await Promise.allSettled([
        api.get<{ ok: boolean; credentials: VerifiedCredential[] }>(
          Api.Wallet,
          `/verified-credentials/mine?agentId=${encodeURIComponent(selectedId)}`,
        ),
        api.get<{ ok: boolean; requests: CredentialRequest[] }>(
          Api.Wallet,
          `/verified-credentials/pending?agentId=${encodeURIComponent(selectedId)}`,
        ),
      ]);
      if (mineResult.status === 'fulfilled') setCredentials(mineResult.value.credentials ?? []);
      if (pendingResult.status === 'fulfilled') setRequests(pendingResult.value.requests ?? []);
      setCredLoading(false);
    })();
  }, [selectedId]);

  // Only show parent agents (no child / linked agents)
  const parentAgents = useMemo(() => agents.filter(a => !a.parentAgentId), [agents]);
  const primaryAgentId = useMemo(() => agents.find(a => a.isPrimary)?.id, [agents]);

  // ─── Sidebar content ───

  const sidebarContent = (
    <div>
      {/* Create agent button */}
      <button
        type="button"
        onClick={() => setShowCreateAgent(true)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left font-mono transition-colors hover:bg-[var(--color-background-alt,#f4f4f5)] border-b border-dashed border-[var(--color-border,#d4d4d8)]"
        style={{ background: 'none', border: 'none', borderBottom: '1px dashed var(--color-border, #d4d4d8)', cursor: 'pointer' }}
      >
        <div className="w-5 h-5 shrink-0 border border-dashed border-[var(--color-border,#d4d4d8)] flex items-center justify-center">
          <Plus size={10} className="text-[var(--color-text-muted,#6b7280)]" />
        </div>
        <span className="text-[9px] font-bold tracking-tight text-[var(--color-text-muted,#6b7280)] uppercase">New Agent</span>
      </button>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '24px' }}>
          <Loader2 size={16} className="animate-spin" style={{ color: 'var(--color-text-muted, #6b7280)' }} />
        </div>
      ) : parentAgents.length === 0 ? (
        <div style={{ padding: '16px', fontSize: '12px', color: 'var(--color-text-muted, #6b7280)', textAlign: 'center' }}>
          No agents found
        </div>
      ) : (
        parentAgents.map((agent) => {
          const p = profiles[agent.id];
          const isActive = agent.id === selectedId;
          const name = p?.displayName || agent.name || (agent.isPrimary ? 'Primary' : agent.id.slice(0, 8));
          const handle = p?.handle ? (p.handle.startsWith('@') ? p.handle : `@${p.handle}`) : null;
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => { setSelectedId(agent.id); setWizardType(null); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left font-mono transition-colors hover:bg-[var(--color-background-alt,#f4f4f5)] ${isActive ? 'bg-[var(--color-background-alt,#f4f4f5)]' : ''}`}
              style={{ background: 'none', border: 'none', borderLeft: isActive ? '2px solid var(--color-accent, #6366f1)' : '2px solid transparent', cursor: 'pointer' }}
            >
              <AgentPfp
                src={p?.pfp}
                isSprite={p?.pfpIsSprite}
                fallbackLetter={agent.name || 'A'}
                size="sm"
              />
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <div className="text-[9px] font-bold tracking-tight text-[var(--color-text,#0a0a0a)] truncate">
                  {name}
                </div>
                {handle && (
                  <div className="text-[7px] text-[var(--color-text-muted,#6b7280)] truncate">
                    {handle}
                  </div>
                )}
              </div>
            </button>
          );
        })
      )}
    </div>
  );

  // ─── Render ───

  return (
    <ViewShell
      sidebar={sidebarContent}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      searchPlaceholder="Search credentials..."
    >
      <div style={{ padding: '32px' }}>
        {!selectedAgent ? (
          <div style={{ color: 'var(--color-text-muted, #6b7280)', fontSize: '13px' }}>
            Select an agent to view details
          </div>
        ) : (
          <div style={{ maxWidth: '560px' }}>
            {/* Agent name + mode badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0, color: 'var(--color-text, #0a0a0a)' }}>
                {selectedAgent.name || (selectedAgent.isPrimary ? 'Primary Agent' : `Agent ${selectedAgent.id.slice(0, 8)}`)}
              </h2>
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  background: selectedAgent.isPrimary
                    ? 'var(--color-accent, #6366f1)'
                    : 'var(--color-border, #d4d4d8)',
                  color: selectedAgent.isPrimary
                    ? 'var(--color-accent-foreground, #ffffff)'
                    : 'var(--color-text-muted, #6b7280)',
                }}
              >
                {selectedAgent.isPrimary ? 'primary' : selectedAgent.mode || 'linked'}
              </span>
            </div>

            {/* Address */}
            <div style={{ marginBottom: '24px' }}>
              <div style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-text-muted, #6b7280)', marginBottom: '4px', letterSpacing: '0.03em' }}>
                ADDRESS
              </div>
              <code
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono, monospace)',
                  color: 'var(--color-text, #0a0a0a)',
                  background: 'var(--color-surface, #f4f4f2)',
                  padding: '6px 10px',
                  borderRadius: '6px',
                  display: 'block',
                  wordBreak: 'break-all',
                  border: '1px solid var(--color-border, #d4d4d8)',
                }}
              >
                {selectedAgent.address}
              </code>
            </div>

            {/* ─── Credentials ─── */}
            {!isUnlocked && (
              <div style={{ ...cardStyle, borderColor: '#f59e0b' }}>
                <div style={{ fontSize: '12px', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <AlertCircle size={14} />
                  Unlock this agent to verify credentials.
                </div>
              </div>
            )}

            {isUnlocked && (
              <>
                {/* Inline tabs */}
                <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid var(--color-border, #d4d4d8)', marginBottom: '16px' }}>
                  {CREDENTIAL_TABS.map((tab) => {
                    const isActive = credentialTab === tab.key;
                    return (
                      <button
                        key={tab.key}
                        onClick={() => { setCredentialTab(tab.key); setWizardType(null); }}
                        style={{
                          padding: '8px 16px',
                          fontSize: '12px',
                          fontWeight: 500,
                          border: 'none',
                          background: 'none',
                          color: isActive ? 'var(--color-accent, #6366f1)' : 'var(--color-text-muted, #6b7280)',
                          borderBottom: isActive ? '2px solid var(--color-accent, #6366f1)' : '2px solid transparent',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                          marginBottom: '-1px',
                        }}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                {credLoading && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                    <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-text-muted, #6b7280)' }} />
                    <span style={mutedText}>Loading credentials...</span>
                  </div>
                )}

                {/* Wizard overlay */}
                {wizardType && (
                  <VerificationWizard
                    credType={wizardType}
                    agentId={selectedId!}
                    onComplete={() => { setWizardType(null); setCredentialTab('credentials'); refreshCredentials(); }}
                    onCancel={() => setWizardType(null)}
                  />
                )}

                {/* Credentials tab — unified grid */}
                {credentialTab === 'credentials' && !credLoading && !wizardType && (
                  <>
                    {/* Approved only checkbox */}
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '12px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={approvedOnly}
                        onChange={(e) => setApprovedOnly(e.target.checked)}
                        style={{ accentColor: 'var(--color-accent, #6366f1)' }}
                      />
                      <span className="font-mono text-[11px] text-[var(--color-text-muted,#6b7280)]">Approved only</span>
                    </label>

                    {credentialTypes.length === 0 ? (
                      <div style={{ ...mutedText, textAlign: 'center', marginTop: '32px' }}>
                        No credential types available
                      </div>
                    ) : (() => {
                      const q = searchValue.trim().toLowerCase();
                      const filtered = credentialTypes.filter((ct) => {
                        if (q && !ct.name.toLowerCase().includes(q) && !ct.description?.toLowerCase().includes(q) && !ct.slug.toLowerCase().includes(q)) return false;
                        if (approvedOnly) {
                          const verified = credentials.find(c => c.credentialType === ct.slug || c.credentialType === `${ct.slug}_account`);
                          if (!verified) return false;
                        }
                        return true;
                      });
                      if (filtered.length === 0) {
                        return (
                          <div style={{ ...mutedText, textAlign: 'center', marginTop: '32px' }}>
                            No credentials found
                          </div>
                        );
                      }
                      return (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '8px' }}>
                          {filtered.map((ct) => {
                            const verified = credentials.find(c => c.credentialType === ct.slug || c.credentialType === `${ct.slug}_account`);
                            const pending = requests.find(r => r.credentialType === ct.slug && (r.status === 'pending' || r.status === 'verifying'));

                            return (
                              <div key={ct.slug} style={cardStyle}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                                  {verified ? (
                                    <BadgeCheck size={16} style={{ color: '#22c55e', flexShrink: 0 }} />
                                  ) : pending ? (
                                    <Clock size={16} style={{ color: '#f59e0b', flexShrink: 0 }} />
                                  ) : (
                                    <Shield size={16} style={{ color: 'var(--color-text-muted, #6b7280)', flexShrink: 0 }} />
                                  )}
                                  <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text, #0a0a0a)' }}>
                                    {ct.name}
                                  </span>
                                </div>
                                {ct.description && (
                                  <div style={{ ...mutedText, marginBottom: '10px' }}>{ct.description}</div>
                                )}
                                {verified ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <Button variant="secondary" size="sm" disabled>
                                      APPROVED
                                    </Button>
                                    <span style={{ ...accentText, fontSize: '12px' }}>
                                      {ct.slug === 'x' ? `@${verified.claimedIdentity}` : verified.claimedIdentity}
                                    </span>
                                  </div>
                                ) : pending ? (
                                  <Button variant="secondary" size="sm" disabled>
                                    PENDING
                                  </Button>
                                ) : (
                                  <Button variant="primary" size="sm" onClick={() => setWizardType(ct)} icon={<ShieldCheck size={11} />}>
                                    VERIFY
                                  </Button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </>
                )}

                {/* Profile tab */}
                {credentialTab === 'profile' && (
                  <ProfileEditor agentId={selectedId!} />
                )}
              </>
            )}
          </div>
        )}
      </div>

      <CreateAgentModal
        isOpen={showCreateAgent}
        onClose={() => setShowCreateAgent(false)}
        onCreated={(newId) => {
          refreshAgents();
          if (newId) setSelectedId(newId);
        }}
        primaryAgentId={primaryAgentId}
      />
    </ViewShell>
  );
}
