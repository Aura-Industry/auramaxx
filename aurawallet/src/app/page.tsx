import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import AuraOSDesktop from './AuraOSDesktop';

const AURAOS_DESCRIPTION = 'The open-source suite of software for working with AI agents.';

const WALLET_INTENT_QUERY_KEYS = new Set([
  'next',
  'returnto',
  'return_to',
  'callbackurl',
  'token',
  'share',
  'sharetoken',
  'share_token',
  'approval',
  'approvaltoken',
  'approval_token',
  'action',
  'actionid',
  'action_id',
  'request',
  'requestid',
  'request_id',
]);

type PageSearchParams = Record<string, string | string[] | undefined>;

export const metadata: Metadata = {
  title: 'AuraOS',
  description: AURAOS_DESCRIPTION,
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'AuraOS',
    title: 'AuraOS',
    description: AURAOS_DESCRIPTION,
    images: [
      {
        url: '/opengraph.webp',
        width: 1512,
        height: 982,
        alt: 'AuraOS',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AuraOS',
    description: AURAOS_DESCRIPTION,
    images: ['/opengraph.webp'],
  },
};

function hasWalletIntent(searchParams: PageSearchParams): boolean {
  return Object.keys(searchParams).some((key) => WALLET_INTENT_QUERY_KEYS.has(key.toLowerCase()));
}

function serializeSearchParams(searchParams: PageSearchParams): string {
  const query = new URLSearchParams();

  for (const [key, rawValue] of Object.entries(searchParams)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== undefined) query.append(key, value);
    }
  }

  return query.toString();
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;

  if (hasWalletIntent(resolvedSearchParams)) {
    const query = serializeSearchParams(resolvedSearchParams);
    redirect(query ? `/wallet?${query}` : '/wallet');
  }

  return <AuraOSDesktop />;
}
