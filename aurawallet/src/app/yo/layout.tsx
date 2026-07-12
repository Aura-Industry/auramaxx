import type { Metadata } from 'next';
import type { ReactNode } from 'react';

const SEO_TITLE = 'AuraWallet';
const SEO_DESCRIPTION = 'Open-source secret manager for AI agents. Share passwords, API keys, and cards with scoped local access.';

export const metadata: Metadata = {
  title: SEO_TITLE,
  description: SEO_DESCRIPTION,
  alternates: {
    canonical: '/yo',
  },
  openGraph: {
    type: 'website',
    url: '/yo',
    siteName: SEO_TITLE,
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    images: [
      {
        url: '/opengraph.webp',
        width: 1512,
        height: 982,
        alt: SEO_TITLE,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    images: ['/opengraph.webp'],
  },
};

export default function YoLayout({ children }: { children: ReactNode }) {
  return children;
}
