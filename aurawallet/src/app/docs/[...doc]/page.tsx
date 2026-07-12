import { redirect } from 'next/navigation';
import DocsPageContent from '../DocsPageContent';
import { getDocsHref, parseDocFilenameFromRouteSegments } from '@/lib/docs';

interface DocsByPathPageProps {
  params: Promise<{
    doc: string[];
  }>;
  searchParams?: Promise<{
    query?: string | string[];
    q?: string | string[];
  }>;
}

const resolveQueryParam = (value?: string | string[]) => {
  if (!value) return '';
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved.trim();
};

const appendSearchQuery = (href: string, searchQuery: string) => {
  const normalized = searchQuery.trim();
  if (!normalized) return href;
  const params = new URLSearchParams({ query: normalized });
  return `${href}?${params.toString()}`;
};

export default async function DocsByPathPage({ params, searchParams }: DocsByPathPageProps) {
  const resolvedParams = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const searchQuery = resolveQueryParam(resolvedSearchParams?.query) || resolveQueryParam(resolvedSearchParams?.q);
  const selectedFilename = parseDocFilenameFromRouteSegments(resolvedParams.doc ?? []);
  const canonicalHref = getDocsHref(selectedFilename);
  const currentHref = `/docs/${(resolvedParams.doc ?? []).map((segment) => encodeURIComponent(segment)).join('/')}`;

  if (canonicalHref !== currentHref) {
    redirect(appendSearchQuery(canonicalHref, searchQuery));
  }

  return <DocsPageContent selectedFilename={selectedFilename} searchQuery={searchQuery} />;
}
