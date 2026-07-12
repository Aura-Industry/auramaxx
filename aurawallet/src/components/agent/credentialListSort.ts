'use client';

import type { CredentialMeta } from './types';

const normalize = (value: string) => value.trim().toLowerCase();

const createdTs = (credential: CredentialMeta) => {
  const created = Date.parse(credential.createdAt);
  if (Number.isFinite(created)) return created;
  return 0;
};

const effectiveAccessTs = (credential: CredentialMeta, latestAccessById?: Record<string, number>) => {
  const known = latestAccessById?.[credential.id];
  if (typeof known === 'number' && Number.isFinite(known) && known > 0) return known;
  return createdTs(credential);
};

const searchRank = (credential: CredentialMeta, query: string) => {
  const q = normalize(query);
  if (!q) return 0;
  const name = normalize(credential.name);
  const username = normalize(String(credential.meta.username || ''));
  const url = normalize(String(credential.meta.url || ''));
  if (name === q) return 3;
  if (name.startsWith(q) || username.startsWith(q) || url.startsWith(q)) return 2;
  if (name.includes(q) || username.includes(q) || url.includes(q)) return 1;
  return 0;
};

export function sortCredentialsForList<T extends CredentialMeta>(
  credentials: T[],
  latestAccessById?: Record<string, number>,
  searchQuery = '',
): T[] {
  return [...credentials].sort((a, b) => {
    const aAccessTs = effectiveAccessTs(a, latestAccessById);
    const bAccessTs = effectiveAccessTs(b, latestAccessById);
    if (bAccessTs !== aAccessTs) return bAccessTs - aAccessTs;

    const aRank = searchRank(a, searchQuery);
    const bRank = searchRank(b, searchQuery);
    if (bRank !== aRank) return bRank - aRank;

    const aFav = a.meta.favorite ? 1 : 0;
    const bFav = b.meta.favorite ? 1 : 0;
    if (bFav !== aFav) return bFav - aFav;

    const aName = normalize(a.name);
    const bName = normalize(b.name);
    const lexical = aName.localeCompare(bName);
    if (lexical !== 0) return lexical;

    return a.id.localeCompare(b.id);
  });
}
