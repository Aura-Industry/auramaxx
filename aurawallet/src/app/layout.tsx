import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { ThemeProvider } from '@/hooks/useTheme';

export const metadata: Metadata = {
  metadataBase: new URL('https://aurawallet.sh'),
  title: 'AuraWallet',
  description: 'Open-source secret manager for AI agents with local storage and scoped access.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {/* SVG Filters for Tyvek Effect */}
        <svg className="absolute w-0 h-0 pointer-events-none" style={{ position: 'absolute', width: 0, height: 0 }}>
          <filter id="tyvekFilter">
            <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="4" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
            <feComponentTransfer>
              <feFuncR type="linear" slope="0.3" />
              <feFuncG type="linear" slope="0.3" />
              <feFuncB type="linear" slope="0.3" />
            </feComponentTransfer>
          </filter>
        </svg>
        <ThemeProvider>
          <Providers>{children}</Providers>
        </ThemeProvider>
        {/* Tyvek texture — global noise overlay (z-index capped + inline pointerEvents for Electron compat) */}
        <div className="tyvek-texture" style={{ opacity: 0.12, zIndex: 0, pointerEvents: 'none' }} />
      </body>
    </html>
  );
}
