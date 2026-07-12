'use client';

import Link from 'next/link';
import React from 'react';

import { DeviceMorphExperience } from '@/components/marketing/DeviceMorphExperience';
import { AuraMaxxSpecOverlay } from '@/components/marketing/AuraMaxxSpecOverlay';

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  return reduced;
}

export default function LandingPage() {
  const reducedMotion = useReducedMotion();
  const [progress, setProgress] = React.useState(0);

  React.useEffect(() => {
    if (reducedMotion) {
      setProgress(0);
      return;
    }

    let raf = 0;
    const update = () => {
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      setProgress(Math.min(1, Math.max(0, window.scrollY / max)));
      raf = 0;
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [reducedMotion]);

  const p = reducedMotion ? 0 : progress;

  return (
    <div className="relative w-full min-h-[500vh] overflow-x-hidden bg-tyvek-dim font-sans" data-testid="hello-page-shell">
      <div className="fixed inset-0 z-[1] pointer-events-none" data-testid="hello-motion-background">
        <div
          data-testid="hello-bg-layer-grid"
          className="absolute inset-0 marketing-grid opacity-45"
          style={{ transform: `translateY(${p * -80}px)`, transition: reducedMotion ? 'none' : 'transform 120ms linear' }}
        />
        <div
          data-testid="hello-bg-layer-tyvek"
          className="absolute inset-0 tyvek-texture mix-blend-multiply opacity-35"
          style={{ transform: `translateY(${p * -40}px) scale(${1 + p * 0.04})`, transition: reducedMotion ? 'none' : 'transform 120ms linear' }}
        />
        <div
          data-testid="hello-bg-layer-radial"
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 15% 20%, rgba(10,10,10,0.10), transparent 38%), radial-gradient(circle at 80% 75%, rgba(255,255,255,0.18), transparent 40%)',
            transform: `translate3d(${p * 24}px, ${p * -24}px, 0)`,
            transition: reducedMotion ? 'none' : 'transform 120ms linear',
          }}
        />
        {reducedMotion && (
          <div data-testid="hello-reduced-motion-fallback" className="sr-only">
            Reduced motion active
          </div>
        )}
      </div>

      <DeviceMorphExperience />
      <AuraMaxxSpecOverlay />

      <footer className="fixed bottom-4 right-4 z-50">
        <nav className="flex items-center gap-3 border border-concrete/30 bg-void/85 px-4 py-2 text-[10px] tracking-widest font-mono text-tyvek backdrop-blur-sm">
          <Link href="/terms" className="hover:text-voltage transition-colors">TERMS</Link>
          <span className="text-concrete/40">|</span>
          <Link href="/privacy" className="hover:text-voltage transition-colors">PRIVACY</Link>
        </nav>
      </footer>

      <div className="thermal-bond">
        <div className="thermal-seal-texture" />
      </div>
    </div>
  );
}
