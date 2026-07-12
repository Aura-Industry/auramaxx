'use client';

import { useCallback, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';

interface ClientSideMarkdownProps {
  html: string;
  className?: string;
}

const hasModifierKey = (event: MouseEvent<HTMLElement>) =>
  event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

export default function ClientSideMarkdown({ html, className }: ClientSideMarkdownProps) {
  const router = useRouter();

  const handleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (hasModifierKey(event)) return;

    const target = event.target as HTMLElement | null;
    const anchor = target?.closest('a');
    if (!anchor) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download')) return;

    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) return;

    let url: URL;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return;
    }

    if (url.origin !== window.location.origin) return;

    event.preventDefault();
    router.push(`${url.pathname}${url.search}${url.hash}`);
  }, [router]);

  return (
    <div
      className={className}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
