'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/design-system';
import { useUpdateChecker } from '@/hooks/useUpdateChecker';

export default function Error({
  error,
}: {
  error: Error & { digest?: string };
}) {
  const { runRestart, restartingServer, restartError } = useUpdateChecker();

  useEffect(() => {
    console.error('[AppErrorBoundary]', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[var(--color-background,#f4f4f5)] relative flex items-center justify-center p-4">
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute inset-0 bg-grid-adaptive bg-[size:4rem_4rem] opacity-30" />
        <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />

        <div className="absolute bottom-[5%] right-[5%] opacity-5 select-none">
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

      <div className="fixed top-6 left-6 z-50 flex items-center gap-3">
        <div className="w-10 h-10">
          <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
        </div>
      </div>

      <div className="fixed top-7 right-6 z-50 flex items-center gap-3 font-mono text-[10px] tracking-widest">
        <Link href="/docs" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">DOCS</Link>
        <Link href="/api" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">API</Link>
        <a href="https://github.com/Aura-Industry/aurawallet" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">GITHUB</a>
        <a href="https://x.com/nicoletteduclar" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">NEED HELP?</a>
      </div>

      <div className="relative z-10 w-full max-w-[380px]">
        <div className="absolute -left-8 top-1/2 -translate-y-1/2 text-vertical label-specimen-sm text-[var(--color-text-faint,#9ca3af)] select-none hidden sm:block">
          SYSTEM&nbsp;STATE
        </div>
        <div className="bg-[var(--color-surface,#f4f4f2)] clip-specimen border-mech shadow-mech overflow-hidden font-mono corner-marks">
          <div className="px-5 py-3 border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] flex items-center justify-between">
            <span className="font-sans font-bold text-sm text-[var(--color-text,#0a0a0a)] uppercase tracking-tight">
              Runtime Error
            </span>
            <span className="text-[9px] text-[var(--color-danger,#ef4444)] font-bold tracking-widest">
              BONKED
            </span>
          </div>

          <div className="p-6">
            <div className="flex flex-col items-center mb-5">
              <div className="w-16 h-16 mb-4">
                <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
              </div>
              <div className="text-[10px] text-[var(--color-text-muted,#6b7280)] tracking-widest text-center uppercase">
                we got bonked
              </div>
              <div className="mt-2 text-[9px] text-[var(--color-text,#0a0a0a)] text-center leading-relaxed">
                AuraWallet hit an unexpected runtime error. Restart the local service to recover.
              </div>
              {error.digest && (
                <div className="mt-3 text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-wider">
                  error digest: {error.digest}
                </div>
              )}
            </div>

            <Button
              type="button"
              variant="primary"
              size="lg"
              loading={restartingServer}
              className="w-full"
              data-testid="error-page-restart-button"
              onClick={() => { void runRestart(); }}
            >
              RESTART AURAWALLET
            </Button>

            {restartError && (
              <div
                className="mt-3 text-[9px] px-3 py-2 border"
                style={{
                  color: 'var(--color-danger,#ef4444)',
                  borderColor: 'color-mix(in srgb, var(--color-danger,#ef4444) 35%, transparent)',
                  background: 'color-mix(in srgb, var(--color-danger,#ef4444) 12%, transparent)',
                }}
              >
                {restartError}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 px-5 py-2 border-t border-[var(--color-border,#d4d4d8)]">
            <div className="h-4 flex-1 bg-[repeating-linear-gradient(90deg,var(--color-text,#000),var(--color-text,#000)_1px,transparent_1px,transparent_3px)] opacity-30" />
            <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-wider">AURAWALLET</span>
          </div>
          <div
            className="h-2 w-full"
            style={{
              backgroundImage: 'repeating-linear-gradient(45deg, var(--color-text, #000), var(--color-text, #000) 5px, transparent 5px, transparent 10px)',
              opacity: 0.1,
            }}
          />
        </div>
      </div>
    </div>
  );
}
