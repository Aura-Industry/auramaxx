'use client';

import React, { useMemo } from 'react';
import { Search, Plus, KeyRound, Upload, RotateCcw, Trash2 } from 'lucide-react';
import { Button, TextInput } from '@/components/design-system';
import { CredentialRow } from './CredentialRow';
import type { CredentialMeta } from './types';
import { sortCredentialsForList } from './credentialListSort';

interface CredentialListProps {
  credentials: CredentialMeta[];
  latestAccessById?: Record<string, number>;
  selectedId: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  canAdd?: boolean;
  onImport?: () => void;
  canImport?: boolean;
  onOpenGenerator?: () => void;
  canGenerate?: boolean;
  onClearFilters?: () => void;
  onCreateWithFilter?: () => void;
  hasActiveFilters?: boolean;
  showSearch?: boolean;
  fieldSearchSuggestions?: string[];
  onApplySearchSuggestion?: (query: string) => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
  onRestoreAll?: () => void;
  canRestoreAll?: boolean;
  onPurgeAll?: () => void;
  canPurgeAll?: boolean;
  className?: string;
  leadingAction?: React.ReactNode;
}

export const CredentialList: React.FC<CredentialListProps> = ({
  credentials,
  latestAccessById,
  selectedId,
  searchQuery,
  onSearchChange,
  onSelect,
  onAdd,
  canAdd = true,
  onImport,
  canImport = true,
  onOpenGenerator,
  canGenerate = true,
  onClearFilters,
  onCreateWithFilter,
  hasActiveFilters = false,
  showSearch = true,
  fieldSearchSuggestions = [],
  onApplySearchSuggestion,
  onRestoreAll,
  canRestoreAll = false,
  onPurgeAll,
  canPurgeAll = false,
  searchInputRef,
  className = 'w-[300px] h-full flex flex-col border-r border-[var(--color-credential-array-border,#8d8d95)]',
  leadingAction,
}) => {
  const showArchiveBulkActions = !!(onRestoreAll || onPurgeAll);
  const sorted = useMemo(() => {
    return sortCredentialsForList(credentials, latestAccessById, searchQuery);
  }, [credentials, latestAccessById, searchQuery]);

  return (
    <div className={className} style={{ fontSize: 'var(--font-size-sm)' }}>
      {/* Pinned header */}
      <div
        className={`border-b border-[var(--color-credential-array-border,#8d8d95)] ${showSearch ? 'flex items-center' : ''}`}
        style={{ gap: 'var(--space-sm)', padding: 'var(--space-md)' }}
      >
        {showSearch ? (
          <>
            {leadingAction}
            <div className="flex-1">
              <TextInput
                compact
                leftElement={<Search size={12} />}
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                inputRef={searchInputRef}
              />
            </div>
            {showArchiveBulkActions ? (
              <>
                {onRestoreAll && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onRestoreAll}
                    icon={<RotateCcw size={10} />}
                    disabled={!canRestoreAll}
                    title="Restore all archived credentials"
                    aria-label="Restore all"
                  >
                    RESTORE ALL
                  </Button>
                )}
                {onPurgeAll && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onPurgeAll}
                    icon={<Trash2 size={10} />}
                    disabled={!canPurgeAll}
                    title="Purge all archived credentials"
                    aria-label="Purge all"
                  >
                    PURGE ALL
                  </Button>
                )}
              </>
            ) : (
              <>
                {onOpenGenerator && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onOpenGenerator}
                    icon={<KeyRound size={10} />}
                    disabled={!canGenerate}
                    title="Generate password"
                    aria-label="Generate password"
                  >
                    GEN
                  </Button>
                )}
                {onImport && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onImport}
                    icon={<Upload size={10} />}
                    disabled={!canImport}
                    title={canImport ? 'Import credentials' : 'Switch to Active to import credentials'}
                    aria-label="Import credentials"
                  >
                    IMPORT
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={onAdd}
                  icon={<Plus size={10} />}
                  disabled={!canAdd}
                  title={canAdd ? 'Create credential' : 'Switch to Active to create credentials'}
                >
                  ADD
                </Button>
              </>
            )}
          </>
        ) : (
          <div className="w-full space-y-2">
            {leadingAction && <div className="flex">{leadingAction}</div>}
            <div className="flex w-full items-center gap-2 overflow-hidden">
              {showArchiveBulkActions ? (
                <>
                  {onRestoreAll && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onRestoreAll}
                      icon={<RotateCcw size={10} />}
                      disabled={!canRestoreAll}
                      title="Restore all archived credentials"
                      aria-label="Restore all"
                      className="flex-1 min-w-0"
                    >
                      RESTORE ALL
                    </Button>
                  )}
                  {onPurgeAll && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onPurgeAll}
                      icon={<Trash2 size={10} />}
                      disabled={!canPurgeAll}
                      title="Purge all archived credentials"
                      aria-label="Purge all"
                      className="flex-1 min-w-0"
                    >
                      PURGE ALL
                    </Button>
                  )}
                </>
              ) : (
                <>
                  {onOpenGenerator && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onOpenGenerator}
                      icon={<KeyRound size={10} />}
                      disabled={!canGenerate}
                      title="Generate password"
                      aria-label="Generate password"
                      className="flex-1 min-w-0"
                    >
                      GEN
                    </Button>
                  )}
                  {onImport && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onImport}
                      icon={<Upload size={10} />}
                      disabled={!canImport}
                      title={canImport ? 'Import credentials' : 'Switch to Active to import credentials'}
                      aria-label="Import credentials"
                      className="flex-1 min-w-0"
                    >
                      IMPORT
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={onAdd}
                    icon={<Plus size={10} />}
                    disabled={!canAdd}
                    title={canAdd ? 'Create credential' : 'Switch to Active to create credentials'}
                    className="flex-1 min-w-0"
                  >
                    ADD
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center h-full px-4">
            <div className="text-center tyvek-label corner-marks p-6">
              <span className="label-specimen text-[var(--color-text-muted,#6b7280)] block">
              {hasActiveFilters ? 'NO SPECIMENS MATCH' : 'NO SPECIMENS FOUND'}
              </span>
              {fieldSearchSuggestions.length > 0 && onApplySearchSuggestion && (
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  {fieldSearchSuggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="font-mono text-[9px] px-2 py-1 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)] text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:border-[var(--color-border-focus,#0a0a0a)]"
                      onClick={() => onApplySearchSuggestion(suggestion)}
                      title={`Search by ${suggestion}`}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
              {hasActiveFilters && onClearFilters && (
                <div className="mt-3 flex flex-col items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onClearFilters}
                  >
                    CLEAR FILTERS
                  </Button>
                  {onCreateWithFilter && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onCreateWithFilter}
                    >
                      CREATE WITH FILTER
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          sorted.map((credential) => (
            <CredentialRow
              key={credential.id}
              credential={credential}
              selected={credential.id === selectedId}
              onClick={() => onSelect(credential.id)}
            />
          ))
        )}
      </div>
    </div>
  );
};
