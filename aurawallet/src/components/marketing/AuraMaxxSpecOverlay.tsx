/*
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  LANDING PAGE REWRITE — CONTENT BLUEPRINT                          ║
 * ║  Date: 2025-02-15 | Source: team audit of docs, todos, page copy   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * DIAGNOSIS
 * ─────────
 * Current page starts at Level 2 (wallet tiers, multi-chain, memory-only auth)
 * and assumes the visitor already knows what "agent wallets" means.
 * It's impressive but alienating. The mecha/spec-sheet aesthetic is strong —
 * keep the visual language, rewrite the content progression.
 *
 * CORE MESSAGE (one sentence)
 * ───────────────────────────
 * "Your AI agent can move money — and you stay in control."
 *
 * That's it. Everything else is detail.
 *
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  REWRITE: SIMPLE → COMPLEX PROGRESSION
 * ═══════════════════════════════════════════════════════════════════════
 *
 *
 * ── SECTION 01: HERO (5 seconds) ─────────────────────────────────────
 *
 *    What someone should understand before they even scroll:
 *
 *    Headline:
 *      "YOUR AGENT CAN MOVE MONEY NOW."
 *
 *    Subline:
 *      "You approve every transaction. From anywhere."
 *
 *    CTA:
 *      [ GET STARTED ]   [ SEE HOW IT WORKS ↓ ]
 *
 *    That's the entire hero. No jargon. No "multi-tier crypto wallet
 *    with agent token system." A person with zero context reads this
 *    and understands: my AI can handle money, I'm still in charge.
 *
 *
 * ── SECTION 02: HOW IT WORKS (30 seconds) ────────────────────────────
 *
 *    Three steps. Visual. Replaces the "fragmentation problem" section
 *    (which assumes the visitor has *already tried* other solutions).
 *
 *    ┌─────────────────────────────────────────────────────┐
 *    │  1. AGENT PROPOSES     "Swap 100 USDC → ETH"       │
 *    │  2. YOU APPROVE        Tap once — phone, laptop,    │
 *    │                        terminal, Telegram, anywhere │
 *    │  3. IT HAPPENS         Transaction executes.        │
 *    │                        Spending limit decremented.  │
 *    └─────────────────────────────────────────────────────┘
 *
 *    This is the "aha" moment. Show the DeviceMorph here — the morphing
 *    device visual *now has context* because the visitor understands
 *    what "approve from anywhere" means.
 *
 *
 * ── SECTION 03: WHY IT'S SAFE (2 minutes) ────────────────────────────
 *
 *    Now we earn trust. Three guarantees, each one sentence:
 *
 *    "KEYS NEVER LEAVE YOUR MACHINE."
 *      Local-first. No cloud. Your keys, your hardware.
 *
 *    "SPENDING LIMITS ARE ENFORCED IN MEMORY."
 *      Not in a database. Not in a config file. In volatile RAM.
 *      Server restart = every token revoked instantly.
 *
 *    "NOTHING MOVES WITHOUT YOUR APPROVAL."
 *      Agents propose. You approve. Cold wallets are human-only.
 *      Hot wallets have per-token caps. Temp wallets auto-sweep.
 *
 *    This is where the current security Q&A cards live — but promoted
 *    to a full section instead of hidden scroll-reveals. The memory-only
 *    auth model is the moat. Lead with it.
 *
 *
 * ── SECTION 04: WHAT IT DOES (2 minutes) ─────────────────────────────
 *
 *    Now the spec sheet. For people who stayed this long, give them
 *    everything. This is where the mecha cards shine:
 *
 *    WALLET TIERS
 *      Cold — human-only, password-protected, source of funds
 *      Hot  — agent-accessible, spending limits, token-gated
 *      Temp — ephemeral, full agent control, auto-sweep back
 *
 *    OPERATIONS
 *      send / swap / fund / launch / wallet-create / approvals
 *
 *    CHAINS
 *      Base · Ethereum · Solana — one backend, one permission model
 *
 *    INTERFACES
 *      Dashboard · Terminal · Telegram · MCP · Claude Code
 *      Same wallet. Same limits. Everywhere.
 *
 *
 * ── SECTION 05: GET STARTED (30 seconds) ─────────────────────────────
 *
 *    Code block. Copy-paste. Done.
 *
 *      npx auramaxx
 *
 *    Then three paths:
 *      → "I'm a developer"    → /docs
 *      → "I'm an AI agent"    → /api
 *      → "Open dashboard"      → /
 *
 *
 * ── SECTION 06: CLOSING (5 seconds) ──────────────────────────────────
 *
 *    Keep the current vision statement — it's good:
 *
 *      "AI MAKES AGENTS POWERFUL. WE MAKE THEM SAFE."
 *
 *    Add: "Open source. MIT licensed. Built for agents."
 *
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  DESIGN NOTES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * KEEP:
 *   - Mecha/industrial aesthetic (crop marks, clip-paths, hazard stripes)
 *   - Tyvek texture background, voltage yellow, void black palette
 *   - Ghost numbers (01, 02, 03...) as structural anchors
 *   - ManifestSection sidebar labels
 *   - ScrollReveal animations
 *   - DeviceMorphExperience component (move to Section 02)
 *
 * CHANGE:
 *   - Hero: strip to one headline + one subline + two CTAs
 *   - Move "how it works" before "why it's safe" before "what it does"
 *   - Promote security from scroll-reveal cards to full section
 *   - Add quickstart code block as its own section
 *   - Add CTA buttons to hero (currently first CTA is in Section 04)
 *   - Footer: add "Open source · MIT licensed" + GitHub link
 *
 * CUT:
 *   - "THE FRAGMENTATION PROBLEM" card (Section 02)
 *     → The visitor hasn't experienced fragmentation yet.
 *       Replace with the 3-step "how it works" which is universally
 *       understandable. The fragmentation argument can live in /docs.
 *   - "EVERY INTERFACE IS AN ISLAND" pull quote
 *     → Assumes prior pain. The device morph already shows
 *       multi-interface support visually.
 *
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  COPY REFERENCE — FINAL HEADLINES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Section 01:  YOUR AGENT CAN MOVE MONEY NOW.
 * Section 02:  THREE STEPS. THAT'S IT.
 * Section 03:  KEYS NEVER LEAVE YOUR MACHINE.
 * Section 04:  SEND. SWAP. LAUNCH. TRACK.
 * Section 05:  TWO COMMANDS. YOU'RE LIVE.
 * Section 06:  AI MAKES AGENTS POWERFUL. WE MAKE THEM SAFE.
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

/* ─── Inline Sub-Components ──────────────────────────────────────────── */

const CropMark = ({ className }: { className?: string }) => (
  <div className={`absolute w-8 h-8 border-voltage/50 pointer-events-none ${className}`} />
);

const ManifestSection: React.FC<{
  children: React.ReactNode;
  className?: string;
  label?: string;
}> = ({ children, className = '', label }) => (
  <section
    className={`relative min-h-screen w-full flex flex-col justify-center border-b border-ink px-4 md:px-12 pointer-events-none ${className}`}
  >
    {/* Sidebar label rail */}
    <div className="absolute left-0 top-0 bottom-0 w-12 border-r border-ink hidden md:flex flex-col items-center justify-between py-8 bg-tyvek-dim/50 backdrop-blur-sm z-20">
      <div className="text-[10px] font-mono rotate-180 text-vertical text-ink/50 tracking-widest">
        {label || 'UNLABELED_SEC'}
      </div>
      <div className="w-px h-12 bg-voltage" />
    </div>
    <div className="pointer-events-auto relative z-10 w-full h-full flex flex-col justify-center pl-0 md:pl-12">
      {children}
    </div>
  </section>
);

const MechaCard: React.FC<{
  children: React.ReactNode;
  className?: string;
  dark?: boolean;
  allowOverflow?: boolean;
}> = ({ children, className = '', dark = false, allowOverflow = false }) => (
  <div
    className={`relative clip-mech-modal border-mech ${dark ? 'bg-void text-tyvek' : 'bg-tyvek text-ink'} ${allowOverflow ? '' : 'overflow-hidden'} ${className}`}
  >
    <div
      className={`absolute top-0 right-0 w-8 h-8 ${dark ? 'bg-voltage' : 'bg-ink'}`}
      style={{ clipPath: 'polygon(100% 0, 0 0, 100% 100%)' }}
    />
    <div className="absolute inset-0 bg-grid-pattern opacity-5 pointer-events-none" />
    {children}
  </div>
);

const MechaButton: React.FC<{
  children: React.ReactNode;
  href?: string;
  variant?: 'primary' | 'secondary';
  className?: string;
}> = ({ children, href, variant = 'primary', className = '' }) => {
  const isPrimary = variant === 'primary';
  const classes = `relative h-14 px-8 font-mono font-bold text-sm uppercase tracking-wider flex items-center justify-center gap-3 clip-mech-header border-mech transition-all duration-200 group ${isPrimary ? 'bg-voltage text-void hover:bg-void hover:text-voltage' : 'bg-void text-tyvek hover:bg-tyvek hover:text-void border border-concrete'} ${className}`;

  const inner = (
    <>
      <div className={`absolute left-0 top-0 w-1 h-full ${isPrimary ? 'bg-void' : 'bg-voltage'}`} />
      {children}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
    </>
  );

  if (href) {
    return (
      <Link href={href} className={classes}>
        {inner}
      </Link>
    );
  }
  return <button className={classes}>{inner}</button>;
};

/** IntersectionObserver-based scroll reveal (replaces framer-motion whileInView) */
const ScrollReveal: React.FC<{
  children: React.ReactNode;
  className?: string;
  delay?: number;
}> = ({ children, className = '', delay = 0 }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(24px)',
        transition: `opacity 0.6s cubic-bezier(0.16,1,0.3,1) ${delay}ms, transform 0.6s cubic-bezier(0.16,1,0.3,1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
};

/* ─── Main Component ─────────────────────────────────────────────────── */

export const AuraMaxxSpecOverlay = () => {
  return (
    <main className="relative z-[10] w-full text-ink font-sans selection:bg-voltage selection:text-void">

      {/* ── FIXED HUD HEADER ─────────────────────────────────────── */}
      <header className="fixed top-0 left-0 w-full z-50 pointer-events-none mix-blend-difference text-white p-4 md:p-6 flex justify-between items-start">
        <div className="flex items-center gap-3">
          <img src="/logo.webp" alt="AuraWallet" className="w-10 h-10 md:w-14 md:h-14 invert" />
          <div>
            <h1 className="text-2xl md:text-4xl font-black tracking-tighter leading-[0.9]">
              AURAWALLET
            </h1>
            <div className="mt-0.5 text-[9px] font-mono tracking-widest opacity-70">
              AGENT CREDENTIAL INFRASTRUCTURE
            </div>
          </div>
        </div>
        <div className="text-right font-mono text-xs">
          <div className="flex items-center gap-2 justify-end mb-1">
            <div className="w-2 h-2 bg-voltage rounded-full animate-pulse shadow-[0_0_8px_#ccff00]" />
            <span className="hidden md:inline">SYSTEM: READY</span>
          </div>
          <nav className="flex gap-3 pointer-events-auto">
            <Link href="/docs" className="text-[10px] tracking-widest hover:text-voltage transition-colors">DOCS</Link>
            <Link href="/api" className="text-[10px] tracking-widest hover:text-voltage transition-colors">API</Link>
            <Link href="/" className="text-[10px] tracking-widest hover:text-voltage transition-colors">HOME</Link>
          </nav>
        </div>
      </header>

      {/* ── SECTION 01: HERO ─────────────────────────────────────── */}
      <ManifestSection label="001_IDENTIFICATION" className="justify-end pb-12">
        <div className="relative max-w-4xl">
          <div
            className="text-[12rem] md:text-[16rem] font-black leading-none text-transparent opacity-10 absolute -top-60 -left-20 select-none pointer-events-none"
            style={{ WebkitTextStroke: '2px #050505' }}
          >
            01
          </div>

          <MechaCard dark className="max-w-2xl p-6 md:p-10">
            <div className="font-mono text-xs mb-4 text-voltage flex justify-between">
              <span>[ MANIFEST // AURAWALLET ]</span>
            </div>
            <h2 className="text-3xl md:text-6xl font-black tracking-tighter mb-6 leading-[1.05]">
              <span className="bg-voltage text-void inline-block px-2 py-0.5">YOUR AGENT</span><br />
              <span className="bg-voltage text-void inline-block px-2 py-0.5 mt-1">CAN OPERATE.</span><br />
              <span className="bg-voltage text-void inline-block px-2 py-0.5 mt-1">YOU NEED AURAWALLET.</span>
            </h2>
            <p className="font-mono text-sm leading-relaxed text-concrete">
              Local-first secret and wallet access for agents. Human approval, least-privilege tokens, and restart-revoked sessions by default.
            </p>

            <div className="mt-6 border border-voltage/30 bg-void/70 p-4 clip-mech-header">
              <div className="font-mono text-[10px] text-concrete uppercase tracking-widest mb-2">Quickstart shell</div>
              <div className="font-mono text-sm text-voltage">$ npx aurawallet</div>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href="https://github.com/Aura-Industry/aurawallet"
                target="_blank"
                rel="noopener noreferrer"
                className="relative h-12 px-6 font-mono font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 clip-mech-header border-mech bg-voltage text-void hover:bg-void hover:text-voltage transition-all"
              >
                GET STARTED ON GITHUB
              </a>
              <MechaButton variant="secondary" href="/docs" className="h-12 px-6 text-xs">
                READ DOCS
              </MechaButton>
            </div>
          </MechaCard>
        </div>

        <div className="absolute bottom-12 right-12 hidden md:flex flex-col items-center animate-bounce">
          <span className="font-mono text-xs text-ink mb-2">SCROLL_TO_INSPECT</span>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M19 12l-7 7-7-7" /></svg>
        </div>
      </ManifestSection>

      {/* ── SECTION 02: CONTEXT (FRAGMENTATION PROBLEM) ──────────── */}
      <ManifestSection label="002_CONTEXT" className="items-center md:items-end">
        <div className="relative max-w-6xl w-full mx-auto flex flex-col md:flex-row items-start justify-between gap-12 z-10">
          {/* Left: Title */}
          <div className="flex-1 text-left pt-12 md:pt-32">
            <div className="relative">
              <div
                className="text-[12rem] md:text-[16rem] font-black leading-none text-transparent opacity-10 absolute -top-60 -left-20 select-none pointer-events-none"
                style={{ WebkitTextStroke: '2px #050505' }}
              >
                02
              </div>
              <h3 className="text-2xl md:text-4xl font-black leading-[0.9] tracking-tight bg-void text-voltage inline-block px-2 py-1">
                AGENTS OPERATE<br />EVERYWHERE.<br />WALLETS DON&apos;T.
              </h3>
            </div>
          </div>

          {/* Right: Content Card */}
          <div className="w-full md:w-auto md:max-w-xl relative">
            {/* Alert badge */}
            <div className="absolute -top-6 -right-6 bg-alert text-white px-6 py-3 font-mono text-sm font-bold transform rotate-3 clip-mech-header z-20 shadow-xl border border-white/20">
              THE FRAGMENTATION PROBLEM
            </div>

            <MechaCard className="p-8 md:p-12 w-full bg-tyvek text-ink shadow-2xl" allowOverflow>
              <CropMark className="top-0 left-0 border-t-2 border-l-2" />
              <CropMark className="bottom-0 right-0 border-b-2 border-r-2" />

              <h3 className="text-2xl font-black uppercase tracking-tight mb-2">
                &quot;EVERY INTERFACE IS AN ISLAND&quot;
              </h3>
              <p className="font-mono text-sm text-concrete mb-8">
                Agents need wallets across every surface — but they get fragmented access instead.
              </p>

              <div className="space-y-4 font-mono text-sm text-left mb-8">
                <div className="flex items-start gap-3">
                  <span className="text-concrete mt-1 shrink-0">BROWSER</span>
                  <div>Web dashboard — but only when you&apos;re at a screen</div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-concrete mt-1 shrink-0">TERMINAL</span>
                  <div>CLI access — but separate auth, separate limits</div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-concrete mt-1 shrink-0">TELEGRAM</span>
                  <div>Bot commands — but no approval flow, no guardrails</div>
                </div>
                <div className="bg-void text-tyvek p-4 clip-mech-header -mx-4 shadow-lg relative">
                  <div className="absolute top-0 right-0 w-2 h-2 bg-alert animate-pulse" />
                  <div className="flex items-start gap-3">
                    <span className="text-voltage mt-1 shrink-0">RESULT</span>
                    <div>
                      <span className="text-voltage font-bold">4 interfaces, 4 permission models</span> — no consistency
                    </div>
                  </div>
                </div>
              </div>

              <p className="font-mono text-sm text-concrete italic text-right border-t border-concrete/20 pt-4">
                &quot;Same agent, different wallet experience everywhere.&quot;
              </p>
            </MechaCard>
          </div>
        </div>
      </ManifestSection>

      {/* ── SECTION 03: CAPABILITIES ─────────────────────────────── */}
      <ManifestSection label="003_CAPABILITIES">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-start">
          {/* Left: Title + Capability Card */}
          <div className="flex flex-col gap-8">
            <div className="relative">
              <div
                className="text-[12rem] md:text-[16rem] font-black leading-none text-transparent opacity-10 absolute -top-40 -left-20 select-none pointer-events-none"
                style={{ WebkitTextStroke: '2px #050505' }}
              >
                03
              </div>
              <h3 className="text-3xl md:text-5xl font-black leading-[0.9] tracking-tight bg-void text-voltage inline-block px-2 py-1 transform -rotate-1 relative z-10 clip-mech-header">
                SEND. SWAP.<br />LAUNCH. TRACK.
              </h3>
            </div>

            <MechaCard className="p-8 md:p-10 bg-tyvek text-ink shadow-2xl" allowOverflow>
              <ul className="space-y-6 font-mono text-sm leading-relaxed">
                <li className="flex items-start gap-4 group">
                  <div className="w-2 h-2 bg-ink mt-2 group-hover:bg-voltage transition-colors shrink-0" />
                  <div>
                    <span className="font-bold">Wallet tiers</span> — cold (human-only), hot (agent + limits), temp (ephemeral)
                  </div>
                </li>
                <li className="flex items-start gap-4 group">
                  <div className="w-2 h-2 bg-ink mt-2 group-hover:bg-voltage transition-colors shrink-0" />
                  <div>
                    <span className="font-bold">Human approvals</span> — agents propose, humans approve, nothing moves silently
                  </div>
                </li>
                <li className="flex items-start gap-4 group">
                  <div className="w-2 h-2 bg-ink mt-2 group-hover:bg-voltage transition-colors shrink-0" />
                  <div>
                    <span className="font-bold">Multi-chain</span> — EVM (Base, Ethereum) + Solana from one backend
                  </div>
                </li>
                <li className="flex items-start gap-4 group">
                  <div className="w-2 h-2 bg-ink mt-2 group-hover:bg-voltage transition-colors shrink-0" />
                  <div className="flex flex-col gap-2">
                    <span className="text-voltage font-bold bg-void px-2 py-0.5 w-fit">Spending limits</span>
                    <span className="font-bold border-l-2 border-voltage pl-3">
                      Per-token caps, session tracking, auto-revoke on restart
                    </span>
                  </div>
                </li>
              </ul>
            </MechaCard>
          </div>

          {/* Right: ScrollReveal Q&A cards */}
          <div className="relative min-h-[600px] flex flex-col justify-center gap-6">
            <ScrollReveal>
              <div className="flex items-center gap-2 mb-2 pl-1">
                <span className="font-mono text-xs font-bold text-voltage uppercase tracking-widest">HOW DOES APPROVAL WORK?</span>
              </div>
              <MechaCard dark className="p-4 border border-voltage/50 bg-void/90">
                <p className="font-mono text-sm text-tyvek leading-tight">
                  Agents request actions via the API. Humans approve in the dashboard, CLI, or Telegram. Token-gated with spending limits enforced in-memory.
                </p>
              </MechaCard>
            </ScrollReveal>

            <ScrollReveal delay={200}>
              <div className="flex items-center gap-2 mb-2 justify-end pr-1">
                <span className="font-mono text-xs font-bold text-ink uppercase tracking-widest">WHAT ABOUT SECURITY?</span>
              </div>
              <MechaCard className="p-5 border-l-4 border-l-ink bg-tyvek shadow-[0_10px_40px_-10px_rgba(0,0,0,0.3)]">
                <div className="space-y-3 font-mono text-sm text-ink">
                  <p className="font-bold">Signing keys live in memory only.</p>
                  <p>Server restart = forced re-approval. Stolen DB is useless without the runtime key.</p>
                  <div className="bg-void text-voltage p-3 clip-mech-footer mt-2 font-bold text-center text-xs md:text-sm">
                    Memory-only auth. Restart = revoke all.
                  </div>
                </div>
              </MechaCard>
            </ScrollReveal>

            <ScrollReveal delay={400}>
              <MechaCard dark className="p-4 border border-concrete/30">
                <div className="font-mono text-xs text-concrete mb-2">SUPPORTED OPERATIONS</div>
                <div className="grid grid-cols-2 gap-2 font-mono text-sm text-voltage">
                  <span>▸ send</span>
                  <span>▸ swap</span>
                  <span>▸ fund</span>
                  <span>▸ launch</span>
                  <span>▸ wallet/create</span>
                  <span>▸ approvals</span>
                </div>
              </MechaCard>
            </ScrollReveal>
          </div>
        </div>
      </ManifestSection>

      {/* ── SECTION 04: INTERFACE (VOLTAGE BG) ───────────────────── */}
      <ManifestSection label="004_INTERFACE" className="bg-voltage text-void min-h-screen relative overflow-hidden">
        <div className="absolute inset-0 bg-grid-pattern-dark opacity-10 pointer-events-none mix-blend-multiply" />
        {/* Hazard Stripes */}
        <div className="absolute top-0 left-0 w-full h-3 bg-hazard-stripes" />
        <div className="absolute bottom-0 left-0 w-full h-3 bg-hazard-stripes" />

        <div className="relative z-10 w-full max-w-5xl mx-auto flex flex-col items-center justify-center text-center py-20">
          {/* Ghost number */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[20rem] md:text-[30rem] font-black leading-none text-void opacity-5 select-none pointer-events-none z-0">
            04
          </div>

          <div className="relative z-10 w-full flex flex-col items-center gap-10">
            <div className="relative">
              <h3 className="text-5xl md:text-8xl font-black leading-[0.9] tracking-tighter text-void uppercase">
                ONE AGENT.<br />
                <span className="text-voltage bg-void px-4 inline-block transform -skew-x-12 mt-2">EVERY INTERFACE.</span>
              </h3>
            </div>

            {/* Bullet points */}
            <div className="bg-void/5 backdrop-blur-sm p-8 clip-mech-modal border border-void/10 max-w-2xl w-full">
              <div className="space-y-6 font-mono text-base md:text-lg text-left">
                <div className="flex items-start gap-4">
                  <div className="w-2 h-2 bg-void mt-2.5 shrink-0" />
                  <p><span className="font-bold">Browser</span> — dashboard, approvals, wallet detail, real-time WebSocket</p>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-2 h-2 bg-void mt-2.5 shrink-0" />
                  <p><span className="font-bold">Terminal</span> — Claude Code, headless CLI, Unix socket IPC</p>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-2 h-2 bg-void mt-2.5 shrink-0" />
                  <p><span className="font-bold">Telegram</span> — approval adapter, bot commands, remote signing</p>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-2 h-2 bg-void mt-2.5 shrink-0" />
                  <p><span className="font-bold">Same wallet, same permissions</span> — everywhere</p>
                </div>
              </div>
            </div>

            <div className="pt-4">
              <MechaButton
                variant="secondary"
                href="/docs"
                className="min-w-[240px] border-2 border-void hover:bg-void hover:text-voltage"
              >
                READ DOCS
              </MechaButton>
            </div>
          </div>

          {/* Floating device silhouettes (CSS-only) */}
          <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
            <div className="absolute top-24 left-8 md:left-16 w-40 md:w-56 h-28 md:h-36 border-2 border-void/10 rounded-lg opacity-40 animate-[float-left_6s_ease-in-out_infinite]" />
            <div className="absolute bottom-20 right-8 md:right-16 w-24 md:w-32 h-44 md:h-56 border-2 border-void/10 rounded-2xl opacity-30 animate-[float-right_7s_ease-in-out_infinite_1s]" />
            <div className="hidden md:block absolute top-8 right-1/4 w-48 h-32 border-2 border-void/10 rounded-md opacity-20 animate-[float-left_5s_ease-in-out_infinite_0.5s]" />
          </div>
        </div>
      </ManifestSection>

      {/* ── FOOTER ───────────────────────────────────────────────── */}
      <footer className="bg-void text-tyvek py-24 px-6 md:px-12 font-mono text-xs relative overflow-hidden">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full text-center pointer-events-none z-0 flex flex-col items-center justify-center">
          <div className="text-[20vw] font-black leading-[0.8] text-white opacity-5 select-none">
            05
          </div>
          <div className="text-[10vw] font-black leading-[0.8] text-white opacity-5 select-none whitespace-nowrap">
            BUILT FOR AGENTS
          </div>
        </div>

        <div className="flex flex-col md:flex-row justify-between items-end relative z-10 gap-8">
          <div className="space-y-6 max-w-lg">
            <div className="space-y-3 font-mono text-sm border-l-2 border-voltage pl-4">
              <p className="font-bold text-lg mb-2 text-white">ABOUT</p>
              <div className="flex items-start gap-3">
                <div className="w-1 h-1 bg-concrete mt-2 shrink-0" />
                <span>Local-first infrastructure for secure password, API key, and wallet sharing with agents</span>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-1 h-1 bg-concrete mt-2 shrink-0" />
                <span>Multi-chain: Base, Ethereum, Solana</span>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-1 h-1 bg-voltage mt-2 shrink-0" />
                <span className="font-bold text-voltage">Memory-only auth, human approvals, spending limits</span>
              </div>
            </div>
            <p className="text-concrete/50 pt-8">ALL RIGHTS RESERVED.</p>
          </div>

          <div className="text-right mt-8 md:mt-0 space-y-4 flex flex-col items-end">
            <img src="/logo.webp" alt="AuraWallet" className="w-16 h-16 invert" />
            <p className="text-concrete text-[10px] tracking-widest uppercase">Agent credential infrastructure</p>
            <nav className="flex gap-4 text-[11px] tracking-widest">
              <Link href="/docs" className="hover:text-voltage transition-colors">DOCS</Link>
              <Link href="/api" className="hover:text-voltage transition-colors">API</Link>
              <Link href="/" className="hover:text-voltage transition-colors">HOME</Link>
            </nav>
            <div className="w-64 h-8 bg-grid-pattern opacity-30 ml-auto" />
          </div>
        </div>
      </footer>

      {/* ── VISION SECTION ───────────────────────────────────────── */}
      <section className="text-ink py-32 flex items-center justify-center relative overflow-hidden">
        <div className="max-w-6xl mx-auto px-6 text-center relative z-10">
          <ScrollReveal>
            <h2 className="text-5xl md:text-8xl font-black tracking-tighter leading-[0.9] mb-8">
              AI MAKES AGENTS <span className="text-concrete">POWERFUL.</span><br />
              WE MAKE THEM <span className="bg-voltage text-void px-2 inline-block transform -skew-x-12">SAFE.</span>
            </h2>
            <p className="font-mono text-xl md:text-3xl text-concrete italic tracking-tight">
              —and they finally use credentials with guardrails.
            </p>
          </ScrollReveal>
        </div>
      </section>
    </main>
  );
};
