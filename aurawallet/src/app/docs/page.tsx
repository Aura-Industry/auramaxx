import { redirect } from 'next/navigation';
import DocsPageContent from './DocsPageContent';
import { getDocsHref, normalizeRequestedDocFilename } from '@/lib/docs';

interface DocsPageProps {
  searchParams?: Promise<{
    doc?: string | string[];
    query?: string | string[];
    q?: string | string[];
  }>;
}

const resolveDocParam = (value?: string | string[]) => {
  if (!value) return null;
  return Array.isArray(value) ? value[0] : value;
};

const resolveSearchQuery = (value?: string | string[]) => {
  const resolved = resolveDocParam(value);
  return resolved ? resolved.trim() : '';
};

const appendSearchQuery = (href: string, searchQuery: string) => {
  const normalized = searchQuery.trim();
  if (!normalized) return href;
  const params = new URLSearchParams({ query: normalized });
  return `${href}?${params.toString()}`;
};

export default async function DocsPage({ searchParams }: DocsPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const selected = resolveDocParam(resolvedSearchParams?.doc);
  const searchQuery = resolveSearchQuery(resolvedSearchParams?.query) || resolveSearchQuery(resolvedSearchParams?.q);
  if (selected) {
    redirect(appendSearchQuery(getDocsHref(normalizeRequestedDocFilename(selected)), searchQuery));
  }
  return <DocsPageContent searchQuery={searchQuery} />;
}
