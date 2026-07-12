'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CSSProperties, useEffect, useMemo, useState } from 'react';
import DocsThemeToggle from '@/components/docs/DocsThemeToggle';
import { Button } from '@/components/design-system';
import { useTheme } from '@/hooks/useTheme';

type InstallMode = 'npm' | 'npx' | 'pnpm' | 'yarn' | 'bash' | 'powershell';

const INSTALL_COMMANDS: Record<InstallMode, string> = {
  npm: 'npm install -g aurawallet',
  npx: 'npx aurawallet',
  pnpm: 'pnpm add -g aurawallet',
  yarn: 'yarn global add aurawallet',
  bash: 'curl -fsSL https://aurawallet.sh/install.sh | bash',
  powershell: 'iwr https://aurawallet.sh/install.ps1 -UseBasicParsing | iex',
};
const INSTALL_MODE_PROMPT: Record<InstallMode, string> = {
  npm: '$',
  npx: '$',
  pnpm: '$',
  yarn: '$',
  bash: '$',
  powershell: 'PS>',
};
const COMMAND_ACCENT_TOKEN = 'aurawallet';
const SCREENSHOT_SLIDES_LIGHT = ['/ss-light1.webp', '/ss-light2.webp', '/ss-light3.webp'] as const;
const SCREENSHOT_SLIDES_DARK = ['/ss-dark1.webp', '/ss-dark2.webp', '/ss-dark3.webp'] as const;
const SCREENSHOT_SLIDE_INTERVAL_MS = 5600;
const MARQUEE_REPEAT_COUNT = 4;

const SPRITE_SHEETS = [
  {
    src: '/agent9.png',
    label: 'Agent 1',
    width: 'clamp(24px, 3.8vw, 40px)',
    height: 'clamp(34px, 5.6vw, 58px)',
    baselineOffset: 'clamp(4px, 0.8vw, 8px)',
    spriteY: '0%',
    cropBottom: '4px',
  },
  {
    src: '/agent10.png',
    label: 'Agent 2',
    width: 'clamp(28px, 4.4vw, 46px)',
    height: 'clamp(40px, 6.4vw, 66px)',
    baselineOffset: '0px',
    spriteY: '0%',
    cropBottom: '0px',
  },
  {
    src: '/agent1.png',
    label: 'Agent 3',
    width: 'clamp(28px, 4.4vw, 46px)',
    height: 'clamp(40px, 6.4vw, 66px)',
    baselineOffset: '0px',
    spriteY: '0%',
    cropBottom: '0px',
  },
  {
    src: '/agent2.png',
    label: 'Agent 4',
    width: 'clamp(28px, 4.4vw, 46px)',
    height: 'clamp(40px, 6.4vw, 66px)',
    baselineOffset: '0px',
    spriteY: '0%',
    cropBottom: '0px',
  },
  {
    src: '/agent3.png',
    label: 'Agent 5',
    width: 'clamp(28px, 4.4vw, 46px)',
    height: 'clamp(40px, 6.4vw, 66px)',
    baselineOffset: '0px',
    spriteY: '0%',
    cropBottom: '0px',
  },
  {
    src: '/agent4.png',
    label: 'Agent 6',
    width: 'clamp(28px, 4.4vw, 46px)',
    height: 'clamp(40px, 6.4vw, 66px)',
    baselineOffset: '0px',
    spriteY: '0%',
    cropBottom: '0px',
  },
  {
    src: '/agent5.png',
    label: 'Agent 7',
    width: 'clamp(28px, 4.4vw, 46px)',
    height: 'clamp(40px, 6.4vw, 66px)',
    baselineOffset: '0px',
    spriteY: '0%',
    cropBottom: '0px',
  },
  {
    src: '/agent6.png',
    label: 'Agent 8',
    width: 'clamp(28px, 4.4vw, 46px)',
    height: 'clamp(40px, 6.4vw, 66px)',
    baselineOffset: '0px',
    spriteY: '0%',
    cropBottom: '0px',
  },
  {
    src: '/agent7.png',
    label: 'Agent 9',
    width: 'clamp(28px, 4.4vw, 46px)',
    height: 'clamp(40px, 6.4vw, 66px)',
    baselineOffset: '0px',
    spriteY: '0%',
    cropBottom: '0px',
  },
  {
    src: '/agent8.png',
    label: 'Agent 10',
    width: 'clamp(28px, 4.4vw, 46px)',
    height: 'clamp(40px, 6.4vw, 66px)',
    baselineOffset: '0px',
    spriteY: '0%',
    cropBottom: '0px',
  },
] as const;

function hashSeed(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function seededUnit(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function getSpriteScatterStyle(src: string, index: number, rowIndex = 0): CSSProperties {
  const base = hashSeed(src) + (index * 97) + (rowIndex * 131);
  const x = (seededUnit(base + 1) - 0.5) * 8;
  const y = (seededUnit(base + 2) - 0.5) * 4 + (rowIndex === 0 ? -1.5 : 1.5);
  const r = (seededUnit(base + 3) - 0.5) * 5;
  const ml = (seededUnit(base + 4) - 0.5) * 8;
  const mr = (seededUnit(base + 5) - 0.5) * 8;
  const scale = 0.72 + (seededUnit(base + 6) * 0.06);

  return {
    marginLeft: `${Math.round(ml)}px`,
    marginRight: `${Math.round(mr)}px`,
    transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${r.toFixed(1)}deg) scale(${scale.toFixed(3)})`,
  };
}

export default function YoPage() {
  const router = useRouter();
  const { colorMode } = useTheme();
  const [installMode, setInstallMode] = useState<InstallMode>('npm');
  const [hideHomeLink, setHideHomeLink] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const installCommand = useMemo(() => INSTALL_COMMANDS[installMode], [installMode]);
  const installCommandParts = useMemo(
    () => installCommand.split(new RegExp(`(${COMMAND_ACCENT_TOKEN})`, 'gi')),
    [installCommand],
  );
  const screenshotSlides = useMemo(
    () => (colorMode === 'dark' ? SCREENSHOT_SLIDES_DARK : SCREENSHOT_SLIDES_LIGHT),
    [colorMode],
  );
  const marqueeSprites = useMemo(
    () => Array.from({ length: MARQUEE_REPEAT_COUNT }, () => SPRITE_SHEETS).flat(),
    [],
  );

  useEffect(() => {
    const hostname = window.location.hostname.toLowerCase();
    setHideHomeLink(hostname === 'aurawallet.sh' || hostname === 'www.aurawallet.sh');
  }, []);

  useEffect(() => {
    const syncViewport = () => {
      setIsMobile(window.innerWidth < 768);
    };
    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setSlideIndex((current) => (current + 1) % screenshotSlides.length);
    }, SCREENSHOT_SLIDE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [screenshotSlides]);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setCopied(false);
    }, 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  useEffect(() => {
    setSlideIndex(0);
  }, [colorMode]);

  const slideCount = screenshotSlides.length;
  const getSlideSlot = (relative: number): 'left' | 'center' | 'right' | 'hidden' => {
    if (relative === 0) return 'center';
    if (relative === 1) return 'right';
    if (relative === slideCount - 1) return 'left';
    return 'hidden';
  };

  const getSlideStyle = (slot: 'left' | 'center' | 'right' | 'hidden', relative: number): CSSProperties => {
    const mobileBase = 'translate(-50%, -42%)';
    const desktopBase = 'translate(-50%, -50%)';
    if (slot === 'center') {
      return {
        zIndex: 20,
        opacity: 1,
        transform: isMobile
          ? `${mobileBase} translate3d(0, 0, 0) scale(1)`
          : `${desktopBase} translate3d(0, 0, 0) scale(1)`,
      };
    }

    if (slot === 'left') {
      return {
        zIndex: 10,
        opacity: 0.92,
        transform: isMobile
          ? `${mobileBase} translate3d(0, clamp(-250px, -23vh, -136px), 0) scale(0.66)`
          : `${desktopBase} translate3d(clamp(-430px, -30vw, -220px), 0, 0) scale(0.68)`,
      };
    }

    if (slot === 'right') {
      return {
        zIndex: 10,
        opacity: 0.92,
        transform: isMobile
          ? `${mobileBase} translate3d(0, clamp(136px, 23vh, 250px), 0) scale(0.66)`
          : `${desktopBase} translate3d(clamp(220px, 30vw, 430px), 0, 0) scale(0.68)`,
      };
    }

    const direction = relative <= slideCount / 2 ? 1 : -1;
    return {
      zIndex: 0,
      opacity: 0,
      transform: isMobile
        ? `${mobileBase} translate3d(0, ${direction > 0 ? '360px' : '-360px'}, 0) scale(0.56)`
        : `${desktopBase} translate3d(${direction > 0 ? '520px' : '-520px'}, 0, 0) scale(0.58)`,
    };
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className="min-h-screen bg-[var(--color-background,#f4f4f5)] relative overflow-hidden" data-testid="yo-page-shell">
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden" aria-hidden="true">
        <div className="absolute inset-0 bg-grid-adaptive bg-[size:4rem_4rem] opacity-30" />
        <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />

        <div className="absolute bottom-[5%] right-[5%] opacity-5 select-none" data-testid="yo-background-branding">
          <h1 className="text-[15vw] font-bold leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter text-right">
            AURAWALLET
          </h1>
        </div>

        <div className="absolute top-10 left-10 w-32 h-32 border-l-4 border-t-4 border-[var(--color-text,#0a0a0a)] opacity-10">
          <div className="absolute top-2 left-2 w-4 h-4 bg-[var(--color-text,#0a0a0a)]" />
        </div>
        <div className="absolute bottom-10 right-10 w-32 h-32 border-r-4 border-b-4 border-[var(--color-text,#0a0a0a)] opacity-10 flex items-end justify-end">
          <div className="absolute bottom-2 right-2 w-4 h-4 bg-[var(--color-text,#0a0a0a)]" />
        </div>
      </div>

      <div className="fixed top-5 right-4 sm:top-7 sm:right-6 z-30 flex items-center gap-2 sm:gap-3 font-mono text-[9px] sm:text-[10px] tracking-widest">
        <Link href="/docs" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">DOCS</Link>
        <Link href="/api" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">API</Link>
        {!hideHomeLink && (
          <Link href="/" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">HOME</Link>
        )}
        <a href="https://github.com/Aura-Industry/aurawallet" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">GITHUB</a>
        <a href="https://x.com/npxauramaxx" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">X</a>
        <a href="https://x.com/nicoletteduclar" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">HELP</a>
        <DocsThemeToggle />
      </div>

      <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-30 flex items-center gap-3 font-mono text-[9px] sm:text-[10px] tracking-widest">
        <Link href="/privacy" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">
          PRIVACY POLICY
        </Link>
        <Link href="/terms" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">
          TERMS
        </Link>
      </div>

      <div className="fixed top-4 left-4 sm:top-6 sm:left-6 z-30 flex items-center gap-2 sm:gap-3">
        <Link href="/" className="w-8 h-8 sm:w-10 sm:h-10 block hover:opacity-80 transition-opacity" aria-label="AuraOS home">
          <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
        </Link>
        <div className="hidden sm:flex sm:flex-col sm:leading-tight">
          <Link href="/" className="font-black text-sm tracking-tight text-[var(--color-text,#0a0a0a)] hover:opacity-80 transition-opacity">
            AURAWALLET
          </Link>
          <a
            href="https://x.com/nicoletteduclar"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
          >
            🗿 by @nicoletteduclar, with love
          </a>
        </div>
      </div>

      <div className="fixed top-20 left-1/2 z-20 w-full max-w-4xl -translate-x-1/2 px-4 pointer-events-none sm:top-24">
        <div className="mx-auto w-full max-w-[min(94vw,740px)] bg-[var(--color-surface,#f4f4f2)] clip-specimen border-mech shadow-mech overflow-hidden font-mono corner-marks pointer-events-auto">
          <div className="px-4 py-2 border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] flex items-center justify-between">
            <span className="font-sans font-bold text-[10px] text-[var(--color-text,#0a0a0a)] uppercase tracking-tight">
              AURAWALLET 🗿🖤
            </span>
            <span className="ml-auto font-mono text-[10px] tracking-[0.12em] uppercase text-[var(--color-text-muted,#6b7280)]">
              npx aurawallet
            </span>
          </div>
          <div className="px-4 py-4 text-center sm:px-6 sm:py-5">
            <h2 className="font-mono text-[clamp(12px,3.2vw,30px)] font-semibold tracking-[0.03em] leading-none text-[var(--color-text,#0a0a0a)]">
              <span className="block whitespace-nowrap">THE OPEN-SOURCE SECRET MANAGER</span>
              <span className="mt-2 block whitespace-nowrap">
                FOR YOUR AGENT.
              </span>
            </h2>
            <p className="mt-2 font-mono text-[11px] sm:text-[12px] tracking-wide text-[var(--color-text-muted,#6b7280)]">
              Securely share passwords, API keys, and cards with AI agents using local storage and scoped access.
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => router.push('/docs')}
              >
                VIEW DOCS
              </Button>
              <iframe
                title="GitHub Star Button"
                src="https://ghbtns.com/github-btn.html?user=Aura-Industry&repo=aurawallet&type=star&count=false&size=large"
                width="95"
                height="30"
                style={{ border: 0 }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="absolute inset-0 z-[1] pointer-events-none flex items-center justify-center overflow-hidden" aria-hidden="true">
        <div className="relative h-[min(82vh,900px)] w-[136vw] md:h-[min(74vh,860px)] md:w-[min(112vw,1720px)]">
          {screenshotSlides.map((src, index) => {
            const relative = (index - slideIndex + slideCount) % slideCount;
            const slot = getSlideSlot(relative);
            const style = getSlideStyle(slot, relative);
            const edgeFadeStyle: CSSProperties = isMobile
              ? (slot === 'left'
                ? {
                  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 28%, black 100%)',
                  maskImage: 'linear-gradient(to bottom, transparent 0%, black 28%, black 100%)',
                }
                : slot === 'right'
                  ? {
                    WebkitMaskImage: 'linear-gradient(to top, transparent 0%, black 28%, black 100%)',
                    maskImage: 'linear-gradient(to top, transparent 0%, black 28%, black 100%)',
                  }
                  : {})
              : (slot === 'left'
                ? {
                  WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 30%, black 100%)',
                  maskImage: 'linear-gradient(to right, transparent 0%, black 30%, black 100%)',
                }
                : slot === 'right'
                  ? {
                    WebkitMaskImage: 'linear-gradient(to left, transparent 0%, black 30%, black 100%)',
                    maskImage: 'linear-gradient(to left, transparent 0%, black 30%, black 100%)',
                  }
                  : {});
            return (
              <div
                key={src}
                className="absolute left-1/2 top-1/2 overflow-hidden transition-[transform,opacity] duration-[1700ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform"
                style={{
                  width: isMobile ? 'min(152vw, 1080px)' : 'min(80vw, 1320px)',
                  height: isMobile ? 'min(74vh, 760px)' : 'min(70vh, 800px)',
                  ...style,
                }}
              >
                <div className="relative h-full w-full" style={edgeFadeStyle}>
                  <img src={src} alt="" className="h-full w-full object-contain" />
                  {isMobile && slot !== 'center' && (
                    <div
                      className="absolute inset-0 pointer-events-none"
                      style={{ background: colorMode === 'dark' ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)' }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <section className="relative z-10 min-h-screen p-4">
        <div className="w-full max-w-4xl">
          <div
            className="fixed bottom-14 left-1/2 z-20 w-[min(94vw,620px)] -translate-x-1/2 overflow-hidden border border-[#222222] bg-[#111111] md:bottom-16"
            data-testid="yo-install-panel"
          >
            <div className="flex items-center justify-between border-b border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2">
              <div className="flex items-center gap-1.5" aria-hidden="true">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 font-mono text-[9px] tracking-widest uppercase">
                  <button
                    type="button"
                    onClick={() => setInstallMode('bash')}
                    aria-pressed={installMode === 'bash'}
                    className={`transition-colors ${installMode === 'bash' ? 'text-[#f5f5f5]' : 'text-[#8b8b8b] hover:text-[#d4d4d4]'}`}
                  >
                    mac os
                  </button>
                  <span className="text-[#5d5d5d]">/</span>
                  <button
                    type="button"
                    onClick={() => setInstallMode('powershell')}
                    aria-pressed={installMode === 'powershell'}
                    className={`transition-colors ${installMode === 'powershell' ? 'text-[#f5f5f5]' : 'text-[#8b8b8b] hover:text-[#d4d4d4]'}`}
                  >
                    powershell
                  </button>
                </div>
                <span className="font-mono text-[9px] tracking-widest uppercase text-[#8b8b8b]">MIT</span>
              </div>
            </div>

            <div className="flex items-center border-b border-[#2a2a2a] bg-[#121212] overflow-x-auto scrollbar-none">
              <button
                type="button"
                onClick={() => setInstallMode('npm')}
                aria-pressed={installMode === 'npm'}
                className={`shrink-0 px-4 py-2 font-mono text-[10px] tracking-widest uppercase transition-colors ${
                  installMode === 'npm'
                    ? 'bg-[#0a0a0a] text-[#f5f5f5]'
                    : 'text-[#8b8b8b] hover:text-[#f5f5f5] hover:bg-[#1b1b1b]'
                }`}
              >
                npm
              </button>
              <button
                type="button"
                onClick={() => setInstallMode('npx')}
                aria-pressed={installMode === 'npx'}
                className={`shrink-0 px-4 py-2 font-mono text-[10px] tracking-widest uppercase transition-colors ${
                  installMode === 'npx'
                    ? 'bg-[#0a0a0a] text-[#f5f5f5]'
                    : 'text-[#8b8b8b] hover:text-[#f5f5f5] hover:bg-[#1b1b1b]'
                }`}
              >
                npx
              </button>
              <button
                type="button"
                onClick={() => setInstallMode('pnpm')}
                aria-pressed={installMode === 'pnpm'}
                className={`shrink-0 px-4 py-2 font-mono text-[10px] tracking-widest uppercase transition-colors ${
                  installMode === 'pnpm'
                    ? 'bg-[#0a0a0a] text-[#f5f5f5]'
                    : 'text-[#8b8b8b] hover:text-[#f5f5f5] hover:bg-[#1b1b1b]'
                }`}
              >
                pnpm
              </button>
              <button
                type="button"
                onClick={() => setInstallMode('yarn')}
                aria-pressed={installMode === 'yarn'}
                className={`shrink-0 px-4 py-2 font-mono text-[10px] tracking-widest uppercase transition-colors ${
                  installMode === 'yarn'
                    ? 'bg-[#0a0a0a] text-[#f5f5f5]'
                    : 'text-[#8b8b8b] hover:text-[#f5f5f5] hover:bg-[#1b1b1b]'
                }`}
              >
                yarn
              </button>
              <button
                type="button"
                onClick={() => setInstallMode('bash')}
                aria-pressed={installMode === 'bash'}
                className={`shrink-0 px-4 py-2 font-mono text-[10px] tracking-widest uppercase transition-colors ${
                  installMode === 'bash'
                    ? 'bg-[#0a0a0a] text-[#f5f5f5]'
                    : 'text-[#8b8b8b] hover:text-[#f5f5f5] hover:bg-[#1b1b1b]'
                }`}
              >
                curl
              </button>
              <button
                type="button"
                onClick={() => setInstallMode('powershell')}
                aria-pressed={installMode === 'powershell'}
                className={`shrink-0 px-4 py-2 font-mono text-[10px] tracking-widest uppercase transition-colors ${
                  installMode === 'powershell'
                    ? 'bg-[#0a0a0a] text-[#f5f5f5]'
                    : 'text-[#8b8b8b] hover:text-[#f5f5f5] hover:bg-[#1b1b1b]'
                }`}
              >
                powershell
              </button>
            </div>

            <div className="flex items-center bg-[#0a0a0a] px-4 py-4">
              <div className="flex min-w-0 items-center gap-1.5">
                <code className="scrollbar-none block min-w-0 overflow-x-auto whitespace-nowrap font-mono text-sm md:text-base text-[#9ca3af]">
                  <span className="mr-2 text-[#7d8590]">{INSTALL_MODE_PROMPT[installMode]}</span>
                  {installCommandParts.map((part, index) => (
                    part.toLowerCase() === COMMAND_ACCENT_TOKEN
                      ? (
                        <span key={`${part}-${index}`} className="text-[var(--color-accent,#34d399)]">
                          {part}
                        </span>
                      )
                      : <span key={`${part}-${index}`}>{part}</span>
                  ))}
                </code>
                <button
                  type="button"
                  onClick={handleCopy}
                  aria-label={copied ? 'Copied command' : 'Copy command'}
                  title={copied ? 'Copied' : 'Copy'}
                  className={`shrink-0 flex h-5 w-5 items-center justify-center transition-colors ${
                    copied ? 'text-[#86efac]' : 'text-[#a3a3a3] hover:text-[#d4d4d4]'
                  }`}
                >
                  {copied ? (
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M13.78 3.97a.75.75 0 0 1 0 1.06L6.97 11.84a.75.75 0 0 1-1.06 0L2.22 8.16a.75.75 0 1 1 1.06-1.06l3.16 3.16 6.28-6.28a.75.75 0 0 1 1.06 0Z"
                      />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M10 1.75A1.75 1.75 0 0 1 11.75 3.5v.75h.75A1.75 1.75 0 0 1 14.25 6v6.5A1.75 1.75 0 0 1 12.5 14.25H6A1.75 1.75 0 0 1 4.25 12.5v-.75H3.5A1.75 1.75 0 0 1 1.75 10V3.5A1.75 1.75 0 0 1 3.5 1.75H10Zm2.5 4H6A.25.25 0 0 0 5.75 6v6.5c0 .14.11.25.25.25h6.5a.25.25 0 0 0 .25-.25V6a.25.25 0 0 0-.25-.25Zm-2.5-2.5H3.5a.25.25 0 0 0-.25.25V10c0 .14.11.25.25.25h.75V6A1.75 1.75 0 0 1 6 4.25h4.25V3.5a.25.25 0 0 0-.25-.25Z"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <div className="border-t border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2.5 md:px-4 md:py-3" data-testid="yo-sprite-row">
              <div className="overflow-hidden">
                <div className="yo-mobile-agent-marquee flex w-max items-end gap-1.5 md:gap-2">
                  {marqueeSprites.map((sprite, index) => {
                    const baseIndex = index % SPRITE_SHEETS.length;
                    const scatter = getSpriteScatterStyle(sprite.src, baseIndex, 0);
                    return (
                      <div key={`${sprite.src}-${index}`} style={scatter}>
                        <div
                          className="yo-sprite"
                          style={{
                            backgroundImage: `url('${sprite.src}')`,
                            animationDelay: `${baseIndex * -150}ms, ${baseIndex * -300}ms`,
                            width: sprite.width,
                            height: sprite.height,
                            marginBottom: sprite.baselineOffset,
                            backgroundPositionY: sprite.spriteY,
                            clipPath: `inset(0 0 ${sprite.cropBottom} 0)`,
                          } as CSSProperties}
                          role="img"
                          aria-label={`${sprite.label} sprite`}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
