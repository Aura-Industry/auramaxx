'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Eye, Link2, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { getWalletBaseUrl } from '@/lib/api';
import Image from 'next/image';
import Link from 'next/link';
import { useParams } from 'next/navigation';

interface ShareMeta {
  token: string;
  credentialId: string;
  credentialName: string;
  credentialType: string;
  expiresAt: number;
  accessMode: 'anyone' | 'password';
  passwordRequired: boolean;
  oneTimeOnly: boolean;
  viewCount: number;
  maxViews: number | null;
}

interface SharedCredentialField {
  key: string;
  value: string;
}

interface SharedCredential {
  id: string;
  name: string;
  type: string;
  meta: Record<string, unknown>;
  fields: SharedCredentialField[];
  createdAt: string;
  updatedAt: string;
}

export default function SharedCredentialPage() {
  const params = useParams<{ token: string | string[] }>();
  const [token, setToken] = useState('');
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [credential, setCredential] = useState<SharedCredential | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [reading, setReading] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const walletBaseUrl = useMemo(() => getWalletBaseUrl(), []);

  const fetchMeta = useCallback(async (shareToken: string) => {
    setLoadingMeta(true);
    setError(null);
    try {
      const res = await fetch(`${walletBaseUrl}/credential-shares/${encodeURIComponent(shareToken)}`);
      const data = await res.json().catch(() => ({ error: 'Invalid response' }));
      if (!res.ok) {
        setError(data.error || 'Failed to load share');
        setMeta(null);
        return;
      }
      setMeta(data.share as ShareMeta);
    } catch {
      setError('Failed to load share');
      setMeta(null);
    } finally {
      setLoadingMeta(false);
    }
  }, [walletBaseUrl]);

  const readShare = useCallback(async (shareToken: string, sharePassword?: string) => {
    setReading(true);
    setError(null);
    try {
      const res = await fetch(`${walletBaseUrl}/credential-shares/${encodeURIComponent(shareToken)}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sharePassword ? { password: sharePassword } : {}),
      });
      const data = await res.json().catch(() => ({ error: 'Invalid response' }));
      if (!res.ok) {
        setError(data.error || 'Failed to read shared credential');
        return;
      }
      setCredential(data.credential as SharedCredential);
    } catch {
      setError('Failed to read shared credential');
    } finally {
      setReading(false);
    }
  }, [walletBaseUrl]);

  useEffect(() => {
    const rawToken = params?.token;
    const shareToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    setToken(shareToken || '');
    if (shareToken) {
      void fetchMeta(shareToken);
    } else {
      setLoadingMeta(false);
      setError('Invalid share link');
    }
  }, [fetchMeta, params]);

  useEffect(() => {
    if (!token || !meta || meta.passwordRequired || credential || reading) return;
    void readShare(token);
  }, [token, meta, credential, reading, readShare]);

  const metaEntries = useMemo(() => {
    if (!credential) return [];
    return Object.entries(credential.meta || {}).filter(([, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    );
  }, [credential]);

  return (
    <div className="min-h-screen bg-tyvek relative flex items-center justify-center p-4 py-8">
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute inset-0 bg-grid-pattern bg-[size:4rem_4rem] opacity-30" />
        <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />

        <div className="absolute top-[5%] left-[5%] opacity-5 select-none">
          <h1 className="text-[15vw] font-bold leading-none text-void font-mono tracking-tighter">STERILE</h1>
        </div>
        <div className="absolute bottom-[5%] right-[5%] opacity-5 select-none">
          <h1 className="text-[15vw] font-bold leading-none text-void font-mono tracking-tighter text-right">FIELD</h1>
        </div>

        <div className="absolute top-10 left-10 w-32 h-32 border-l-4 border-t-4 border-void opacity-10">
          <div className="absolute top-2 left-2 w-4 h-4 bg-void" />
        </div>
        <div className="absolute bottom-10 right-10 w-32 h-32 border-r-4 border-b-4 border-void opacity-10 flex items-end justify-end">
          <div className="absolute bottom-2 right-2 w-4 h-4 bg-void" />
        </div>
      </div>

      <Link href="/wallet" className="fixed top-6 left-6 z-50 flex items-center gap-3 hover:opacity-80 transition-opacity">
        <div className="w-10 h-10">
          <Image src="/logo.webp" alt="AuraWallet" width={40} height={40} className="w-full h-full object-contain" priority />
        </div>
        <div className="font-black text-xl tracking-tighter text-black">AURAWALLET</div>
      </Link>

      <div className="relative z-10 w-full max-w-2xl">
        <div className="bg-[#f4f4f2] border border-black/10 shadow-lg overflow-hidden font-mono">
          <div className="px-4 py-3 border-b border-black/10 bg-white/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Link2 size={15} className="text-black/70" />
              <h1 className="text-[11px] font-bold uppercase tracking-[0.22em] text-black">SHARED CREDENTIAL</h1>
            </div>
            <span className="text-[9px] text-black/40 tracking-wider">
              {credential ? 'ACCESS_GRANTED' : meta?.passwordRequired ? 'LOCKED' : 'PENDING'}
            </span>
          </div>

          <div className="px-4 pb-4 pt-4 space-y-4">
            {loadingMeta && (
              <div className="flex items-center gap-2 text-[10px] text-black/60 uppercase tracking-widest">
                <Loader2 size={12} className="animate-spin" />
                LOADING SHARE
              </div>
            )}

            {!loadingMeta && error && !credential && (
              <div className="border border-red-300 bg-red-100/40 p-3">
                <div className="flex items-center gap-2 text-[10px] text-red-700 uppercase tracking-wider">
                  <AlertTriangle size={12} />
                  {error}
                </div>
              </div>
            )}

            {!loadingMeta && meta && !credential && !meta.passwordRequired && reading && (
              <div className="flex items-center gap-2 text-[10px] text-black/60 uppercase tracking-widest">
                <Loader2 size={12} className="animate-spin" />
                DECRYPTING PAYLOAD
              </div>
            )}

            {!loadingMeta && meta && !credential && meta.passwordRequired && (
              <div className="space-y-3">
                <div className="text-[10px] text-black/60 uppercase tracking-wider">
                  This shared credential is password protected.
                </div>
                <div className="space-y-1">
                  <label htmlFor="share-password" className="block text-[8px] font-bold text-black/50 uppercase tracking-[0.14em]">
                    SHARE PASSWORD
                  </label>
                  <input
                    id="share-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password"
                    className="w-full h-10 px-3 border border-black/20 bg-white text-[11px] text-black placeholder:text-black/35 outline-none focus:border-black transition-colors"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => { void readShare(token, password); }}
                  disabled={!password || reading}
                  className="h-9 px-4 flex items-center justify-center gap-2 border border-black/20 bg-white hover:border-black text-[10px] font-bold uppercase tracking-wider text-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {reading ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
                  UNLOCK
                </button>

                {error && (
                  <div className="text-[9px] text-red-700 uppercase tracking-wider">{error}</div>
                )}
              </div>
            )}

            {credential && (
              <div className="space-y-4">
                {meta && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-voltage/10 border border-voltage/20">
                    <ShieldCheck size={13} className="text-green-600" />
                    <span className="text-[10px] font-bold text-black uppercase tracking-wider">AUTHENTIC SHARE</span>
                    <span className="text-[9px] text-black/50 ml-auto">
                      {meta.oneTimeOnly ? 'ONE_TIME' : 'MULTI_VIEW'}
                    </span>
                  </div>
                )}

                <div>
                  <div className="text-[14px] font-bold text-black uppercase tracking-tight">{credential.name}</div>
                  <div className="text-[9px] uppercase tracking-widest text-black/60">
                    {credential.type}
                    {meta?.oneTimeOnly ? ' · One-time view' : ''}
                  </div>
                  {meta && (
                    <div className="text-[9px] text-black/50 mt-1">Expires {new Date(meta.expiresAt).toLocaleString()}</div>
                  )}
                </div>

                {metaEntries.length > 0 && (
                  <div className="border border-dashed border-black/20 p-3 bg-white/40">
                    <div className="flex justify-between items-center mb-2 border-b border-black/10 pb-1">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-black">METADATA</span>
                      <span className="text-[8px] text-black/40 font-bold">
                        QTY: {metaEntries.length.toString().padStart(2, '0')}
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {metaEntries.map(([key, value]) => (
                        <div key={key} className="grid grid-cols-[140px_1fr] gap-2 py-1 border-b border-black/10">
                          <div className="text-[9px] uppercase tracking-widest text-black/60">{key}</div>
                          <div className="text-[10px] break-all text-black">{String(value)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="border border-dashed border-black/20 p-3 bg-white/40">
                  <div className="flex justify-between items-center mb-2 border-b border-black/10 pb-1">
                    <span className="text-[9px] font-bold uppercase tracking-widest text-black">SHARED_FIELDS</span>
                    <span className="text-[8px] text-black/40 font-bold">
                      QTY: {credential.fields.length.toString().padStart(2, '0')}
                    </span>
                  </div>

                  {credential.fields.length === 0 ? (
                    <div className="text-[10px] text-black/60 uppercase tracking-wider">No sensitive fields.</div>
                  ) : (
                    <div className="space-y-1.5">
                      {credential.fields.map((field) => (
                        <div key={field.key} className="grid grid-cols-[140px_1fr] gap-2 py-1 border-b border-black/10">
                          <div className="text-[9px] uppercase tracking-widest text-black/60">{field.key}</div>
                          <div className="text-[10px] break-all flex items-start gap-1.5 text-black">
                            <Eye size={10} className="mt-0.5 shrink-0" />
                            <span>{field.value}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {credential && (
            <div className="px-4 py-2 border-t border-black/10 bg-white/30">
              <div className="text-[8px] text-black/40 uppercase tracking-widest mb-1">SHARE TOKEN</div>
              <div className="text-[9px] text-black font-bold break-all leading-relaxed">{token}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
