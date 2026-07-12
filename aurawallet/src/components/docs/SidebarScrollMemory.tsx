'use client';

import { useLayoutEffect } from 'react';

interface SidebarScrollMemoryProps {
  containerId: string;
  storageKey: string;
}

export default function SidebarScrollMemory({ containerId, storageKey }: SidebarScrollMemoryProps) {
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const node = document.getElementById(containerId);
    if (!node) return;

    const restore = () => {
      const saved = window.sessionStorage.getItem(storageKey);
      if (!saved) return;
      const parsed = Number.parseInt(saved, 10);
      if (!Number.isFinite(parsed)) return;
      node.scrollTop = parsed;
    };

    const persist = () => {
      window.sessionStorage.setItem(storageKey, String(node.scrollTop));
    };

    // Restore before paint when possible, then once more on the next frame
    // to survive layout shifts caused by route updates.
    restore();
    const raf = requestAnimationFrame(restore);

    const onScroll = () => {
      persist();
    };

    const onClickCapture = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('a[href]')) {
        persist();
      }
    };

    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('click', onClickCapture, { capture: true });

    return () => {
      cancelAnimationFrame(raf);
      persist();
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('click', onClickCapture, { capture: true });
    };
  }, [containerId, storageKey]);

  return null;
}
