'use client';

import React from 'react';

type StageId = 'terminal' | 'browser' | 'telegram' | 'browser-chat';

interface StageDefinition {
  id: StageId;
  label: string;
  shell: 'browser' | 'terminal' | 'phone';
  accent: string;
  width: number;
  height: number;
  radius: number;
  tiltX: number;
  tiltY: number;
  scale: number;
  title: string;
  subtitle: string;
  lines: string[];
}

const STAGES: StageDefinition[] = [
  {
    id: 'terminal',
    label: 'PHASE_01',
    shell: 'terminal',
    accent: '#22c55e',
    width: 780,
    height: 430,
    radius: 10,
    tiltX: 5,
    tiltY: -6,
    scale: 0.98,
    title: 'AURAWALLET // CLAUDE CODE',
    subtitle: 'Terminal',
    lines: [
      '$ aurawallet unlock --wallet hot',
      '> swap 100 USDC → ETH on Base',
      '> approval: pending human...',
      '✓ approved. tx 0xa3f…executed.',
    ],
  },
  {
    id: 'browser',
    label: 'PHASE_02',
    shell: 'browser',
    accent: '#0047ff',
    width: 760,
    height: 450,
    radius: 18,
    tiltX: 8,
    tiltY: -8,
    scale: 1,
    title: 'AURAWALLET // DASHBOARD',
    subtitle: 'Browser',
    lines: [
      'HOT WALLET          0.82 ETH',
      'PENDING APPROVAL     1',
      '─────────────────────────',
      '▸ send 0.1 ETH → ops.eth  [APPROVE]',
    ],
  },
  {
    id: 'telegram',
    label: 'PHASE_03',
    shell: 'phone',
    accent: '#3b82f6',
    width: 360,
    height: 640,
    radius: 34,
    tiltX: 7,
    tiltY: -8,
    scale: 1.04,
    title: 'AURAWALLET // TELEGRAM',
    subtitle: 'Bot Approval',
    lines: [
      '🤖 Aura Agent',
      'Swap 0.5 SOL → USDC?',
      '[ ✓ Approve ]  [ ✕ Reject ]',
      '✓ Approved. Signature posted.',
    ],
  },
  {
    id: 'browser-chat',
    label: 'PHASE_04',
    shell: 'browser',
    accent: '#0ea5e9',
    width: 760,
    height: 450,
    radius: 18,
    tiltX: 6,
    tiltY: -7,
    scale: 1,
    title: 'AURAWALLET // WEB CHAT',
    subtitle: 'Conversational',
    lines: [
      '> you: send 0.1 eth to ops wallet',
      '< agent: preparing transfer...',
      '< agent: ready. confirm?',
      '> you: confirm',
      '< agent: tx submitted. hash 0xf2c…',
    ],
  },
];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

const useScrollProgress = () => {
  const [progress, setProgress] = React.useState(0);

  React.useEffect(() => {
    let raf = 0;
    const update = () => {
      const scrollMax = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const next = clamp(window.scrollY / scrollMax, 0, 1);
      setProgress(next);
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
  }, []);

  return progress;
};

const StageScreen = ({ stage, opacity }: { stage: StageDefinition; opacity: number }) => (
  <div
    className="absolute inset-0 p-4 md:p-6 pointer-events-none"
    style={{ opacity }}
  >
    <div className="flex items-center justify-between border-b border-white/15 pb-3">
      <div className="text-[10px] md:text-xs font-mono tracking-widest text-white/70">{stage.title}</div>
      <div className="text-[10px] md:text-xs font-mono font-bold" style={{ color: stage.accent }}>{stage.subtitle}</div>
    </div>
    <div className="mt-3 md:mt-5 space-y-2 md:space-y-3">
      {stage.lines.map((line) => (
        <div
          key={`${stage.id}-${line}`}
          className="font-mono text-[11px] md:text-[13px] tracking-wide text-white/88"
        >
          {line}
        </div>
      ))}
    </div>
  </div>
);

export const DeviceMorphExperience = () => {
  const progress = useScrollProgress();
  const scaled = progress * (STAGES.length - 1);
  const fromIndex = Math.floor(scaled);
  const toIndex = clamp(fromIndex + 1, 0, STAGES.length - 1);
  const localT = smooth(scaled - fromIndex);

  const from = STAGES[clamp(fromIndex, 0, STAGES.length - 1)];
  const to = STAGES[toIndex];

  const width = mix(from.width, to.width, localT);
  const height = mix(from.height, to.height, localT);
  const radius = mix(from.radius, to.radius, localT);
  const tiltX = mix(from.tiltX, to.tiltX, localT);
  const tiltY = mix(from.tiltY, to.tiltY, localT);
  const scale = mix(from.scale, to.scale, localT);

  const alphaCurrent = 1 - localT;
  const alphaNext = localT;

  return (
    <div className="fixed inset-0 z-[2] pointer-events-none">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(0,71,255,0.16),transparent_40%),radial-gradient(circle_at_85%_75%,rgba(204,255,0,0.16),transparent_35%),linear-gradient(180deg,#f2f3ef_0%,#eceee8_100%)]" />
      <div className="marketing-grid absolute inset-0 opacity-60" />
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="relative overflow-hidden border border-black/25 bg-[#0b0f18] shadow-[0_22px_80px_rgba(0,0,0,0.35)]"
          style={{
            width: `${width}px`,
            maxWidth: '92vw',
            height: `${height}px`,
            maxHeight: '76vh',
            borderRadius: `${radius}px`,
            transform: `perspective(1400px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale(${scale})`,
            transformStyle: 'preserve-3d',
          }}
        >
          <div className="absolute inset-x-0 top-0 h-9 md:h-10 border-b border-white/10 bg-black/35 backdrop-blur-[2px] flex items-center px-3 gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ef4444]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#f59e0b]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#22c55e]" />
            <span className="ml-auto font-mono text-[10px] text-white/60 tracking-widest">{from.label}</span>
          </div>

          <div className="absolute inset-0 pt-9 md:pt-10">
            <StageScreen stage={from} opacity={alphaCurrent} />
            <StageScreen stage={to} opacity={alphaNext} />
          </div>

          <div className="absolute inset-0 bg-[linear-gradient(transparent_50%,rgba(255,255,255,0.03)_50%)] bg-[length:100%_4px] opacity-30" />
          <div className="marketing-scan" />
        </div>
      </div>
    </div>
  );
};
