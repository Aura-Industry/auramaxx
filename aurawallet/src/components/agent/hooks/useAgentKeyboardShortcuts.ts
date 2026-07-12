import { RefObject, useEffect } from 'react';
import { CredentialMeta } from '../types';

type Params = {
  filteredCredentials: CredentialMeta[];
  selectedId: string | null;
  isMobile: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  onCreateCredential: () => void;
  setSelectedId: (id: string) => void;
  setMobileDetailOpen: (open: boolean) => void;
};

export function useAgentKeyboardShortcuts({
  filteredCredentials,
  selectedId,
  isMobile,
  searchRef,
  onCreateCredential,
  setSelectedId,
  setMobileDetailOpen,
}: Params) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      const isEditable = isInput || target.isContentEditable;

      const lowerKey = e.key.toLowerCase();
      if ((!isEditable && (e.metaKey || e.ctrlKey) && lowerKey === 'k') || (!isEditable && e.key === '/')) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }

      const isCreateShortcut = !isEditable
        && (e.metaKey || e.ctrlKey)
        && e.altKey
        && (lowerKey === 'n' || e.code === 'KeyN');
      if (isCreateShortcut) {
        e.preventDefault();
        onCreateCredential();
        return;
      }

      if (!isInput && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const currentIndex = filteredCredentials.findIndex((c) => c.id === selectedId);
        if (e.key === 'ArrowDown') {
          const next = currentIndex + 1;
          if (next < filteredCredentials.length) setSelectedId(filteredCredentials[next].id);
        } else {
          const prev = currentIndex - 1;
          if (prev >= 0) setSelectedId(filteredCredentials[prev].id);
        }
      }

      if (!isInput && e.key === 'Enter' && filteredCredentials.length > 0) {
        e.preventDefault();
        const nextId = selectedId ?? filteredCredentials[0].id;
        setSelectedId(nextId);
        if (isMobile) setMobileDetailOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredCredentials, selectedId, isMobile, searchRef, onCreateCredential, setSelectedId, setMobileDetailOpen]);
}
