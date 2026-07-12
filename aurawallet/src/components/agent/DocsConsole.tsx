'use client';

import React, { useCallback, useEffect, useState } from 'react';

type ViewMode = 'desktop' | 'tablet' | 'mobile';

type DocListItem = {
  filename: string;
  title: string;
  summary: string;
};

type DocsPlainResponse = {
  success: boolean;
  docs: DocListItem[];
  selectedFile: string;
  content: string;
  markdownHtml?: string;
  error?: string;
};

const DEFAULT_DOC_FILENAME = 'README.md';

interface DocsConsoleProps {
  mode?: ViewMode;
  searchQuery?: string;
}

export const DocsConsole: React.FC<DocsConsoleProps> = ({
  mode = 'desktop',
  searchQuery = '',
}) => {
  const [docs, setDocs] = useState<DocListItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>(DEFAULT_DOC_FILENAME);
  const [markdownHtml, setMarkdownHtml] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const listWidthClass = mode === 'tablet'
    ? 'w-[320px]'
    : mode === 'mobile'
      ? 'w-[220px]'
      : 'w-[300px]';

  const loadDoc = useCallback(async (filename: string) => {
    setError(null);
    try {
      const params = new URLSearchParams({ file: filename || DEFAULT_DOC_FILENAME });
      const normalizedSearch = searchQuery.trim();
      if (normalizedSearch) params.set('q', normalizedSearch);
      const response = await fetch(`/api/docs/plain?${params.toString()}`);
      const payload = await response.json() as DocsPlainResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || `Failed to load ${filename}`);
      }
      setDocs(payload.docs);
      setSelectedFile(payload.selectedFile);
      setMarkdownHtml(payload.markdownHtml || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load docs');
      setMarkdownHtml('');
    }
  }, [searchQuery]);

  useEffect(() => {
    void loadDoc(selectedFile || DEFAULT_DOC_FILENAME);
  }, [loadDoc]);

  return (
    <div className="flex-1 h-full overflow-hidden flex">
      <aside className={`${listWidthClass} h-full border-r border-[var(--color-border,#d4d4d8)] overflow-y-auto scrollbar-tyvek`}>
        <div className="px-3 py-2 border-b border-[var(--color-border,#d4d4d8)]">
          <div className="text-[10px] font-bold tracking-widest text-[var(--color-text,#0a0a0a)]">DOCS</div>
          <div className="text-[8px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">Markdown Viewer</div>
        </div>
        <div className="p-1">
          {docs.map((doc) => (
            <button
              key={doc.filename}
              type="button"
              onClick={() => {
                void loadDoc(doc.filename);
              }}
              className="w-full text-left px-2 py-2 hover:bg-[var(--color-background-alt,#f4f4f5)] transition-colors"
              style={{
                borderLeft: selectedFile === doc.filename
                  ? '2px solid var(--color-accent, #ccff00)'
                  : '2px solid transparent',
              }}
              title={doc.filename}
            >
              <div className="text-[9px] tracking-wide font-bold text-[var(--color-text,#0a0a0a)] truncate">
                {doc.title}
              </div>
              <div className="text-[8px] text-[var(--color-text-muted,#6b7280)] truncate">
                {doc.filename}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="flex-1 h-full overflow-y-auto scrollbar-tyvek">
        <div className="p-5">
          {error ? (
            <div className="text-[10px] text-[var(--color-danger,#ef4444)]">{error}</div>
          ) : (
            <div className="prose-mono max-w-none" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
          )}
        </div>
      </div>
    </div>
  );
};
