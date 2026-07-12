import { redirect } from 'next/navigation';
import { ApiReferencePageContent } from '../page';
import { getApiDocHref, parseApiDocFilenameFromRouteSegments } from '@/lib/api-docs';

interface ApiByPathPageProps {
  params: Promise<{ doc: string[] }>;
  searchParams?: Promise<{ query?: string | string[]; q?: string | string[] }>;
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

export default async function ApiByPathPage({ params, searchParams }: ApiByPathPageProps) {
  const resolvedParams = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const searchQuery = resolveQueryParam(resolvedSearchParams?.query) || resolveQueryParam(resolvedSearchParams?.q);
  const selectedFilename = parseApiDocFilenameFromRouteSegments(resolvedParams.doc ?? []);
  const canonicalHref = getApiDocHref(selectedFilename);
  const currentHref = `/api/${(resolvedParams.doc ?? []).map((segment) => encodeURIComponent(segment)).join('/')}`;

  if (canonicalHref !== currentHref) {
    redirect(appendSearchQuery(canonicalHref, searchQuery));
  }

  return <ApiReferencePageContent selectedFilename={selectedFilename} searchQuery={searchQuery} />;
}
