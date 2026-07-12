import Link from 'next/link';
import { headers } from 'next/headers';
import PersistentDocGroup from '@/components/docs/PersistentDocGroup';
import DocsThemeToggle from '@/components/docs/DocsThemeToggle';
import ShareUrlButton from '@/components/docs/ShareUrlButton';
import ClientSideMarkdown from '@/components/docs/ClientSideMarkdown';
import SidebarScrollMemory from '@/components/docs/SidebarScrollMemory';
import DocsSearchBar from '@/components/docs/DocsSearchBar';

import {
  README_DOC_FILENAME,
  getDocsHref,
  listDocFiles,
  listDocGroups,
  normalizeRequestedDocFilename,
  readDocFile,
  renderMarkdown,
} from '@/lib/docs';

interface DocsPageContentProps {
  selectedFilename?: string | null;
  searchQuery?: string;
}

const appendSearchQuery = (href: string, searchQuery: string) => {
  const normalized = searchQuery.trim();
  if (!normalized) return href;
  const params = new URLSearchParams({ query: normalized });
  return `${href}?${params.toString()}`;
};

const docMatchesSearch = (
  doc: { filename: string; title: string; summary: string },
  normalizedQuery: string,
) => {
  if (!normalizedQuery) return true;
  const haystack = `${doc.filename} ${doc.title} ${doc.summary}`.toLowerCase();
  return haystack.includes(normalizedQuery);
};

const getDocNavLabel = (filename: string) => {
  if (filename === 'README.md') return 'QUICKSTART';
  const base = filename.split('/').pop() ?? filename;
  if (base.toLowerCase() === 'readme.md') {
    const parent = filename.split('/').slice(-2, -1)[0];
    return parent ? `${parent}` : 'README';
  }
  return base.replace(/\.md$/i, '');
};

const getGroupStorageKey = (label: string) =>
  `docs:sidebar:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const shouldHideHomeLink = async () => {
  const requestHeaders = await headers();
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host') ?? '';
  const firstHost = host.split(',')[0]?.trim() ?? '';
  const hostname = firstHost.split(':')[0].toLowerCase();
  return hostname === 'aurawallet.sh' || hostname === 'www.aurawallet.sh';
};

export default async function DocsPageContent({ selectedFilename, searchQuery = '' }: DocsPageContentProps) {
  const hideHomeLink = await shouldHideHomeLink();
  const docs = await listDocFiles();
  const groups = await listDocGroups();
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const normalizedSelected = selectedFilename ? normalizeRequestedDocFilename(selectedFilename) : null;
  const selectedDoc = docs.find((doc) => doc.filename === normalizedSelected) ?? docs[0];
  const filteredGroups = normalizedSearch
    ? groups
      .map((group) => ({
        ...group,
        docs: group.docs.filter((doc) => docMatchesSearch(doc, normalizedSearch)),
      }))
      .filter((group) => group.docs.length > 0)
    : groups;
  const autoOpenSections = normalizedSearch.length > 0;
  const visibleDocCount = filteredGroups.reduce((count, group) => count + group.docs.length, 0);
  const getDocLinkHref = (filename: string) => appendSearchQuery(getDocsHref(filename), searchQuery);
  const shareUrl = `https://aurawallet.sh${getDocLinkHref(selectedDoc?.filename ?? README_DOC_FILENAME)}`;
  const rawContent = selectedDoc ? await readDocFile(selectedDoc.filename) : '# No docs found';
  const contentForRender = selectedDoc?.filename === README_DOC_FILENAME
    ? rawContent
      .replace(/^!\[[^\]]*\]\(\.\/public\/README\.png\)\s*$/m, '')
      .replace(/\n{3,}/g, '\n\n')
    : rawContent;
  const html = renderMarkdown(contentForRender, { currentDocFilename: selectedDoc?.filename });

  return (
    <div className="min-h-screen bg-[var(--color-background,#f4f4f5)] relative p-4 py-8">
      {/* Background matching Sterile Field */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        {/* Sterile Grid */}
        <div className="absolute inset-0 bg-grid-adaptive bg-[size:4rem_4rem] opacity-30" />

        {/* Tyvek Texture Overlay */}
        <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />

        {/* Giant Background Typography */}
        <div className="absolute top-[5%] left-[5%] opacity-5 select-none">
          <h1 className="text-[15vw] font-bold leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter">
            AURA
          </h1>
        </div>
        <div className="absolute bottom-[5%] right-[5%] opacity-5 select-none">
          <h1 className="text-[15vw] font-bold leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter text-right">
            MAXXING
          </h1>
        </div>

        {/* Lab Markings - Corner Finder Patterns */}
        <div className="absolute top-10 left-10 w-32 h-32 border-l-4 border-t-4 border-[var(--color-text,#0a0a0a)] opacity-10">
          <div className="absolute top-2 left-2 w-4 h-4 bg-[var(--color-text,#0a0a0a)]" />
        </div>
        <div className="absolute bottom-10 right-10 w-32 h-32 border-r-4 border-b-4 border-[var(--color-text,#0a0a0a)] opacity-10 flex items-end justify-end">
          <div className="absolute bottom-2 right-2 w-4 h-4 bg-[var(--color-text,#0a0a0a)]" />
        </div>
      </div>

      {/* Logo header */}
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

      {/* Nav */}
      <div className="fixed top-5 right-4 sm:top-7 sm:right-6 z-30 flex items-center gap-2 sm:gap-3 font-mono text-[9px] sm:text-[10px] tracking-widest">
        <Link href="/api" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">API</Link>
        {!hideHomeLink && (
          <Link href="/" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">HOME</Link>
        )}
        <a href="https://github.com/Aura-Industry/aurawallet" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">GITHUB</a>
        <a href="https://x.com/npxauramaxx" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">X</a>
        <a href="https://x.com/nicoletteduclar" target="_blank" rel="noopener noreferrer" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">HELP</a>
        <DocsThemeToggle />
      </div>

      <div className="relative z-[5] max-w-[1400px] mx-auto pt-16">
        <div className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
          {/* Sidebar (sticky) */}
          <aside className="font-mono">
            <div id="docs-sidebar-scroll-container" className="md:sticky md:top-20 md:max-h-[calc(100vh-6rem)] md:overflow-y-auto">
              <SidebarScrollMemory containerId="docs-sidebar-scroll-container" storageKey="docs:sidebar:scroll" />
              <details open className="group sidebar-always-open bg-[var(--color-surface,#f4f4f2)] border border-[var(--color-border,#d4d4d8)] shadow-lg overflow-hidden font-mono">
                <summary className="px-4 py-3 border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] flex items-center justify-between cursor-pointer md:cursor-default list-none [&::-webkit-details-marker]:hidden">
                  <Link href="/docs" className="font-sans font-bold text-sm text-[var(--color-text,#0a0a0a)] uppercase tracking-tight hover:opacity-70 transition-opacity">Index</Link>
                  <span className="flex items-center gap-2">
                    <span className="text-[9px] text-[var(--color-text-faint,#9ca3af)] font-bold">QTY: {visibleDocCount.toString().padStart(3, '0')}</span>
                    <svg className="w-3 h-3 text-[var(--color-text-muted,#6b7280)] transition-transform group-open:rotate-180 md:hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
                  </span>
                </summary>
                <div className="p-3 space-y-4">
                  {filteredGroups.map((group) => (
                    group.docs.some((doc) => doc.filename === README_DOC_FILENAME) ? (
                      <div key={group.label}>
                        <div className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest mb-1 px-1 uppercase">{group.label}</div>
                        <div className="space-y-0.5">
                          {group.docs.map((doc) => {
                            const isActive = selectedDoc?.filename === doc.filename;
                            return (
                              <Link
                                key={doc.filename}
                                href={getDocLinkHref(doc.filename)}
                                className={`block px-3 py-1.5 text-[11px] uppercase transition-colors border ${
                                  isActive
                                    ? 'border-[var(--color-border,#d4d4d8)] bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)]'
                                    : 'border-transparent hover:border-[var(--color-border-muted,#e5e5e5)] hover:bg-[var(--color-surface-alt,#fafafa)] text-[var(--color-text-muted,#6b7280)]'
                                }`}
                              >
                                {getDocNavLabel(doc.filename)}
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <PersistentDocGroup
                        key={group.label}
                        storageKey={getGroupStorageKey(group.label)}
                        label={group.label}
                        forceOpen={autoOpenSections}
                      >
                        {group.docs.map((doc) => {
                          const isActive = selectedDoc?.filename === doc.filename;
                          return (
                            <Link
                              key={doc.filename}
                              href={getDocLinkHref(doc.filename)}
                              className={`block px-3 py-1.5 text-[11px] uppercase transition-colors border ${
                                isActive
                                  ? 'border-[var(--color-border,#d4d4d8)] bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)]'
                                  : 'border-transparent hover:border-[var(--color-border-muted,#e5e5e5)] hover:bg-[var(--color-surface-alt,#fafafa)] text-[var(--color-text-muted,#6b7280)]'
                              }`}
                            >
                              {getDocNavLabel(doc.filename)}
                            </Link>
                          );
                        })}
                      </PersistentDocGroup>
                    )
                  ))}

                  {filteredGroups.length === 0 && (
                    <div className="px-1 py-2 text-[9px] text-[var(--color-text-muted,#6b7280)]">
                      No docs found for &quot;{searchQuery}&quot;.
                    </div>
                  )}

                  {/* REFERENCE — links to dedicated /api page */}
                  <div>
                    <div className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest mb-1 px-1">REFERENCE</div>
                    <Link
                      href="/api"
                      className="flex items-center gap-2 px-3 py-1.5 text-[11px] border border-transparent hover:border-[var(--color-border-muted,#e5e5e5)] hover:bg-[var(--color-surface-alt,#fafafa)] text-[var(--color-text-muted,#6b7280)] transition-colors"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                      API ENDPOINTS
                    </Link>
                  </div>
                </div>
                {/* Barcode + Stripe */}
                <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--color-border,#d4d4d8)]">
                  <div className="h-4 flex-1 bg-[repeating-linear-gradient(90deg,var(--color-text,#000),var(--color-text,#000)_1px,transparent_1px,transparent_3px)] opacity-30" />
                </div>
                <div className="h-2 w-full" style={{
                  backgroundImage: 'repeating-linear-gradient(45deg, var(--color-text, #000), var(--color-text, #000) 5px, transparent 5px, transparent 10px)',
                  opacity: 0.1,
                }} />
              </details>
            </div>
          </aside>

          {/* Content */}
          <div className="bg-[var(--color-surface,#f4f4f2)] border border-[var(--color-border,#d4d4d8)] shadow-lg overflow-hidden font-mono">
            <div className="px-4 py-3 border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] flex items-center justify-between">
              <span className="font-sans font-bold text-sm text-[var(--color-text,#0a0a0a)] uppercase tracking-tight">
                {selectedDoc?.title ?? 'Documentation'}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-[var(--color-text-muted,#6b7280)]">{selectedDoc?.filename}</span>
                <ShareUrlButton url={shareUrl} />
              </div>
            </div>

            <ClientSideMarkdown className="p-5 prose-mono" html={html} />

            {/* Footer */}
            <div className="px-4 py-2 border-t border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)]">
              <div className="text-[8px] text-[var(--color-text-faint,#9ca3af)] uppercase tracking-wider mb-1">DOCUMENT REFERENCE</div>
              <div className="text-[9px] text-[var(--color-text,#0a0a0a)] font-bold">{selectedDoc?.filename}</div>
            </div>

            {/* Barcode + Stripe */}
            <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--color-border,#d4d4d8)]">
              <div className="h-4 flex-1 bg-[repeating-linear-gradient(90deg,var(--color-text,#000),var(--color-text,#000)_1px,transparent_1px,transparent_3px)] opacity-30" />
              <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-wider">AURAWALLET</span>
            </div>
            <div className="h-2 w-full" style={{
              backgroundImage: 'repeating-linear-gradient(45deg, var(--color-text, #000), var(--color-text, #000) 5px, transparent 5px, transparent 10px)',
              opacity: 0.1,
            }} />
          </div>
        </div>
      </div>

      <DocsSearchBar initialQuery={searchQuery} />
    </div>
  );
}
