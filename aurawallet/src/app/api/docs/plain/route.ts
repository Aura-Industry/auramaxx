import { NextRequest, NextResponse } from 'next/server';
import {
  README_DOC_FILENAME,
  listDocFiles,
  normalizeRequestedDocFilename,
  readDocFile,
  renderMarkdown,
} from '@/lib/docs';

/**
 * GET /api/docs/plain?file=<filename>&q=<query>
 * Returns docs list plus rendered markdown for selected file.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const requestedFile = searchParams.get('file') || README_DOC_FILENAME;
    const normalizedRequested = normalizeRequestedDocFilename(requestedFile);
    const rawQuery = searchParams.get('q') || '';
    const normalizedQuery = rawQuery.trim().toLowerCase();
    const isDevMode = process.env.NODE_ENV !== 'production';

    // Embedded agent docs only expose internal docs in dev mode.
    const allDocs = (await listDocFiles()).filter((doc) => isDevMode || !doc.filename.startsWith('internal/'));
    const contentByFile = new Map<string, string>();
    const docs = normalizedQuery
      ? (await Promise.all(allDocs.map(async (doc) => {
          const content = await readDocFile(doc.filename);
          contentByFile.set(doc.filename, content);
          const haystack = `${doc.filename}\n${doc.title}\n${doc.summary}\n${content}`.toLowerCase();
          return haystack.includes(normalizedQuery) ? doc : null;
        }))).filter((doc): doc is NonNullable<typeof doc> => doc !== null)
      : allDocs;

    if (docs.length === 0) {
      const markdownHtml = normalizedQuery
        ? renderMarkdown(`No docs match \`${rawQuery.trim()}\`.`)
        : renderMarkdown('No docs found.');
      return NextResponse.json({
        success: true,
        docs: [],
        selectedFile: '',
        content: '',
        markdownHtml,
      });
    }

    const available = new Set(docs.map((doc) => doc.filename));
    const fallback = available.has(README_DOC_FILENAME)
      ? README_DOC_FILENAME
      : docs[0]?.filename || README_DOC_FILENAME;
    const selectedFile = available.has(normalizedRequested) ? normalizedRequested : fallback;
    const content = contentByFile.get(selectedFile) ?? await readDocFile(selectedFile);
    const markdownHtml = renderMarkdown(content, { currentDocFilename: selectedFile });

    return NextResponse.json({
      success: true,
      docs: docs.map((doc) => ({
        filename: doc.filename,
        title: doc.title,
        summary: doc.summary,
      })),
      selectedFile,
      content,
      markdownHtml,
    });
  } catch (error) {
    console.error('[DocsPlain] Failed to load docs:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load docs content' },
      { status: 500 },
    );
  }
}
