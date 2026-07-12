import Link from 'next/link';

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[var(--color-background,#f4f4f5)] relative p-4 py-8">
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute inset-0 bg-grid-adaptive bg-[size:4rem_4rem] opacity-30" />
        <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />
        <div className="absolute top-[5%] left-[5%] opacity-5 select-none">
          <h1 className="text-[15vw] font-bold leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter">
            AURA
          </h1>
        </div>
        <div className="absolute bottom-[5%] right-[5%] opacity-5 select-none">
          <h1 className="text-[15vw] font-bold leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter text-right">
            PRIVACY
          </h1>
        </div>
      </div>

      <Link
        href="/hello"
        className="fixed top-6 left-6 z-50 flex items-center gap-3 hover:opacity-80 transition-opacity"
      >
        <div className="w-10 h-10">
          <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
        </div>
        <div className="font-black text-xl tracking-tighter text-[var(--color-text,#0a0a0a)]">AURAWALLET</div>
      </Link>

      <div className="fixed top-7 right-6 z-50 flex items-center gap-3 font-mono text-[10px] tracking-widest">
        <Link href="/terms" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">TERMS</Link>
        <Link href="/docs" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">DOCS</Link>
        <Link href="/" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">HOME</Link>
      </div>

      <main className="relative z-[5] max-w-[920px] mx-auto pt-16">
        <article className="bg-[var(--color-surface,#f4f4f2)] border border-[var(--color-border,#d4d4d8)] shadow-lg overflow-hidden font-mono">
          <header className="px-5 py-4 border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] flex items-center justify-between">
            <h1 className="font-sans font-bold text-sm text-[var(--color-text,#0a0a0a)] uppercase tracking-tight">
              Privacy Policy
            </h1>
            <span className="text-[9px] text-[var(--color-text-muted,#6b7280)] tracking-widest">LOCAL-FIRST</span>
          </header>

          <div className="p-6 space-y-5 text-[13px] leading-6 text-[var(--color-text,#0a0a0a)]">
            <p>Zero personal data is collected.</p>
            <p>No analytics, no tracking, and no telemetry are built into AuraWallet.</p>
            <p>All agent data is stored locally on your machine.</p>
            <p>Aura does not have access to your credentials.</p>
            <p>
              AuraWallet is fully open source, so you can inspect and audit the code yourself at any time.
            </p>
          </div>

          <footer className="px-5 py-3 border-t border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] text-[9px] tracking-widest text-[var(--color-text-faint,#9ca3af)] uppercase">
            We never receive your secrets
          </footer>
        </article>
      </main>
    </div>
  );
}
