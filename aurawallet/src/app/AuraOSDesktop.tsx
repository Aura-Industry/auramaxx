'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

type DesktopApp = {
  name: string;
  description: string;
  icon: ReactNode;
  href?: string;
  external?: boolean;
  primary?: boolean;
};

const iconClassName = 'h-full w-full';

function WalletIcon() {
  return (
    <svg viewBox="0 0 72 72" className={iconClassName} aria-hidden="true" fill="none">
      <rect x="10" y="13" width="52" height="46" rx="13" fill="currentColor" opacity="0.12" />
      <rect x="14" y="17" width="44" height="38" rx="10" stroke="currentColor" strokeWidth="2" />
      <circle cx="36" cy="36" r="11" stroke="currentColor" strokeWidth="2" />
      <circle cx="36" cy="36" r="3" fill="currentColor" />
      <path d="M36 25v4M36 43v4M25 36h4M43 36h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M19 22h8M19 50h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.65" />
      <circle cx="56" cy="17" r="6" fill="var(--color-accent,#ccff00)" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ChessIcon() {
  return (
    <svg viewBox="0 0 72 72" className={iconClassName} aria-hidden="true" fill="none">
      <path d="M23 55h29M26 49h23l-3-8c-2-6-1-11 2-17l-11-8-13 11 8 3-7 11 1 8Z" fill="currentColor" opacity="0.13" />
      <path d="M23 55h29M26 49h23l-3-8c-2-6-1-11 2-17l-11-8-13 11 8 3-7 11 1 8Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="38" cy="24" r="1.8" fill="currentColor" />
    </svg>
  );
}

function LauncherIcon() {
  return (
    <svg viewBox="0 0 72 72" className={iconClassName} aria-hidden="true" fill="none">
      <path d="M41 14c9 2 15 8 17 17L39 50l-17-17 19-19Z" fill="currentColor" opacity="0.12" />
      <path d="M41 14c9 2 15 8 17 17L39 50l-17-17 19-19Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="44" cy="28" r="5" stroke="currentColor" strokeWidth="2" />
      <path d="M27 38l-10 2-5 9 15-2M34 45l-2 10-9 5 2-15M19 53l-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RegistryIcon() {
  return (
    <svg viewBox="0 0 72 72" className={iconClassName} aria-hidden="true" fill="none">
      <rect x="14" y="15" width="44" height="42" rx="5" fill="currentColor" opacity="0.1" />
      <rect x="14" y="15" width="44" height="42" rx="5" stroke="currentColor" strokeWidth="2" />
      <path d="M14 29h44M14 43h44" stroke="currentColor" strokeWidth="2" />
      <path d="M22 22h18M22 36h12M22 50h21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="51" cy="22" r="2" fill="currentColor" />
      <circle cx="51" cy="36" r="2" fill="currentColor" />
      <circle cx="51" cy="50" r="2" fill="currentColor" />
    </svg>
  );
}

function PackageIcon() {
  return (
    <svg viewBox="0 0 72 72" className={iconClassName} aria-hidden="true" fill="none">
      <path d="M14 25 36 13l22 12v24L36 61 14 49V25Z" fill="currentColor" opacity="0.1" />
      <path d="M14 25 36 13l22 12v24L36 61 14 49V25Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="m14 25 22 12 22-12M36 37v24M25 19l22 12v9" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

const APPS: DesktopApp[] = [
  {
    name: 'AuraWallet',
    description: 'Secret manager for AI agents',
    href: '/wallet',
    primary: true,
    icon: <WalletIcon />,
  },
  { name: 'AuraChess', description: 'Coming soon', icon: <ChessIcon /> },
  { name: 'AuraLauncher', description: 'Coming soon', icon: <LauncherIcon /> },
  { name: 'AuraRegistry', description: 'Coming soon', icon: <RegistryIcon /> },
  { name: 'AuraPM', description: 'Coming soon', icon: <PackageIcon /> },
];

const tileClassName = 'group relative flex min-h-[124px] w-full flex-col items-center justify-start rounded-xl border border-transparent px-2 py-3 text-center text-[var(--color-text,#0a0a0a)] transition duration-200 hover:border-[color-mix(in_srgb,var(--color-border,#d4d4d8)_70%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-surface,#fff)_52%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus,#0a0a0a)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent';

function AppTile({ app }: { app: DesktopApp }) {
  const content = (
    <>
      <span
        className={`relative flex items-center justify-center rounded-[18px] border bg-[color-mix(in_srgb,var(--color-surface,#fff)_72%,transparent)] shadow-[0_12px_28px_rgba(15,23,42,0.13)] transition duration-200 group-hover:-translate-y-1 group-hover:shadow-[0_17px_34px_rgba(15,23,42,0.18)] ${app.primary ? 'h-[78px] w-[78px] border-[var(--color-text,#0a0a0a)] p-2 text-[var(--color-text,#0a0a0a)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-accent,#ccff00)_55%,transparent),0_14px_32px_rgba(15,23,42,0.18)]' : 'h-[70px] w-[70px] border-[var(--color-border,#d4d4d8)] p-2.5'}`}
      >
        {app.icon}
        {app.primary && (
          <span className="absolute -right-2 -top-2 rounded-full border border-[var(--color-text,#0a0a0a)] bg-[var(--color-accent,#ccff00)] px-1.5 py-0.5 font-mono text-[7px] font-bold tracking-[0.12em] text-[var(--color-accent-foreground,#0a0a0a)]">
            OPEN
          </span>
        )}
      </span>
      <span className="mt-3 max-w-full rounded-md bg-[color-mix(in_srgb,var(--color-surface,#fff)_72%,transparent)] px-2 py-1 text-[12px] font-semibold leading-none shadow-sm backdrop-blur-md">
        {app.name}
      </span>
    </>
  );

  if (!app.href) {
    return (
      <div
        className={`${tileClassName} cursor-not-allowed opacity-50 grayscale-[0.35] hover:translate-y-0 hover:border-transparent hover:bg-transparent`}
        aria-disabled="true"
        title={`${app.name} — coming soon`}
        data-testid={`desktop-app-${app.name.toLowerCase()}`}
      >
        {content}
        <span className="absolute right-1 top-1 rounded-full border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] px-1.5 py-0.5 font-mono text-[7px] font-bold tracking-[0.14em] text-[var(--color-text-muted,#6b7280)]">
          SOON
        </span>
      </div>
    );
  }

  if (app.external) {
    return (
      <a
        href={app.href}
        target="_blank"
        rel="noreferrer"
        className={tileClassName}
        aria-label={`${app.name}: ${app.description} (opens in a new tab)`}
        data-testid={`desktop-app-${app.name.toLowerCase()}`}
      >
        {content}
      </a>
    );
  }

  return (
    <Link
      href={app.href}
      className={tileClassName}
      aria-label={`${app.name}: ${app.description}`}
      data-testid={`desktop-app-${app.name.toLowerCase()}`}
    >
      {content}
    </Link>
  );
}

function formatClock(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export default function AuraOSDesktop() {
  const [clock, setClock] = useState('—:—');
  const [welcomeOpen, setWelcomeOpen] = useState(true);

  useEffect(() => {
    const updateClock = () => setClock(formatClock(new Date()));
    updateClock();
    const timer = window.setInterval(updateClock, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="auraos-desktop relative z-10 isolate min-h-[100dvh] overflow-x-hidden text-[var(--color-text,#0a0a0a)]">
      <header className="relative z-30 flex h-9 items-center justify-between border-b border-[color-mix(in_srgb,var(--color-border,#d4d4d8)_72%,transparent)] bg-[color-mix(in_srgb,var(--color-surface,#fff)_72%,transparent)] px-3 shadow-[0_1px_0_rgba(255,255,255,0.25)] backdrop-blur-xl sm:px-5">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] font-bold tracking-[0.12em]">AuraOS</span>
          <span className="hidden h-3 w-px bg-[var(--color-border,#d4d4d8)] sm:block" />
          <span className="hidden font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--color-text-muted,#6b7280)] sm:inline">
            Desktop
          </span>
        </div>
        <time
          className="min-w-[4.5rem] text-right font-mono text-[10px] tabular-nums tracking-[0.08em] text-[var(--color-text-muted,#6b7280)]"
          aria-label="Current time"
          suppressHydrationWarning
        >
          {clock}
        </time>
      </header>

      <div className="relative z-20 flex min-h-[calc(100dvh-2.25rem)] flex-col px-4 pb-10 pt-7 sm:px-7 sm:pt-9 lg:px-10">
        <section aria-label="Applications" className="w-full max-w-[470px]">
          <div className="mb-5 flex items-end justify-between border-b border-[color-mix(in_srgb,var(--color-border,#d4d4d8)_65%,transparent)] pb-2">
            <div>
              <p className="font-mono text-[8px] uppercase tracking-[0.22em] text-[var(--color-text-muted,#6b7280)]">System / Applications</p>
              <h1 className="mt-1 text-xl font-semibold tracking-[-0.04em] sm:text-2xl">Your agent software.</h1>
            </div>
            <span className="hidden font-mono text-[8px] uppercase tracking-[0.16em] text-[var(--color-text-faint,#9ca3af)] sm:block">01 active</span>
          </div>

          <div className="grid grid-cols-2 gap-x-2 gap-y-1 min-[430px]:grid-cols-3 sm:gap-x-4" data-testid="desktop-app-grid">
            {APPS.map((app) => <AppTile key={app.name} app={app} />)}
          </div>
        </section>

        {welcomeOpen && (
          <aside className="mt-8 w-full max-w-md self-end overflow-hidden rounded-xl border border-[var(--color-border,#d4d4d8)] bg-[color-mix(in_srgb,var(--color-surface,#fff)_80%,transparent)] shadow-[0_24px_70px_rgba(15,23,42,0.18)] backdrop-blur-xl lg:absolute lg:bottom-14 lg:right-10 lg:mt-0" aria-labelledby="welcome-title">
            <div className="flex h-8 items-center justify-between border-b border-[var(--color-border,#d4d4d8)] bg-[color-mix(in_srgb,var(--color-surface-alt,#fafafa)_82%,transparent)] px-3">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[var(--color-accent,#ccff00)] shadow-[0_0_0_1px_var(--color-text,#0a0a0a)]" />
                <span className="font-mono text-[8px] uppercase tracking-[0.17em] text-[var(--color-text-muted,#6b7280)]">Welcome.aura</span>
              </div>
              <button
                type="button"
                onClick={() => setWelcomeOpen(false)}
                className="flex h-5 w-5 items-center justify-center rounded border border-transparent font-mono text-xs leading-none text-[var(--color-text-muted,#6b7280)] transition hover:border-[var(--color-border,#d4d4d8)] hover:bg-[var(--color-surface,#fff)] hover:text-[var(--color-text,#0a0a0a)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus,#0a0a0a)]"
                aria-label="Close welcome window"
              >
                ×
              </button>
            </div>
            <div className="p-5 sm:p-6">
              <p className="font-mono text-[8px] uppercase tracking-[0.2em] text-[var(--color-text-faint,#9ca3af)]">Aura system 0.1</p>
              <h2 id="welcome-title" className="mt-2 text-xl font-semibold tracking-[-0.035em]">Welcome to AuraOS</h2>
              <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted,#6b7280)]">
                The open-source suite of software for your agents.
              </p>
              <Link href="/wallet" className="mt-5 inline-flex items-center gap-2 border-b border-[var(--color-text,#0a0a0a)] pb-1 font-mono text-[9px] font-bold uppercase tracking-[0.16em] transition hover:text-[var(--app-blue-text,#0047ff)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus,#0a0a0a)] focus-visible:ring-offset-2">
                Open AuraWallet <span aria-hidden="true">↗</span>
              </Link>
            </div>
          </aside>
        )}

        <div className="mt-auto flex items-center gap-2 pt-8 font-mono text-[8px] uppercase tracking-[0.17em] text-[var(--color-text-faint,#9ca3af)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success,#00c853)]" />
          Local system ready
        </div>
      </div>
    </main>
  );
}
