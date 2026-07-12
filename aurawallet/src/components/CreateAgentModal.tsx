'use client';

import React, { useCallback, useState } from 'react';
import { Dices } from 'lucide-react';
import { api, Api } from '@/lib/api';
import { encryptPassword } from '@/lib/crypto';
import { Modal, TextInput, Button } from '@/components/design-system';
import { PasswordGenerator } from '@/components/agent/PasswordGenerator';

// const AGENT_MODE_OPTIONS: { value: 'linked' | 'independent'; label: string }[] = [
//   { value: 'linked', label: 'Child (inherits parent unlock)' },
//   { value: 'independent', label: 'Independent (separate password)' },
// ];

export function CreateAgentModal({
  isOpen,
  onClose,
  onCreated,
  primaryAgentId,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (agentId?: string) => void;
  primaryAgentId?: string;
}) {
  const [name, setName] = useState('');
  // const [mode, setMode] = useState<'linked' | 'independent'>('independent');
  // const [parentId, setParentId] = useState('');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [showPasswordGen, setShowPasswordGen] = useState(false);
  const [saveToVault, setSaveToVault] = useState(true);

  const reset = useCallback(() => {
    setName('');
    // setMode('independent');
    // setParentId('');
    setPassword('');
    setSaveToVault(true);
  }, []);

  const handleClose = useCallback(() => {
    onClose();
    reset();
  }, [onClose, reset]);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    if (password.length < 8) return;

    setCreating(true);
    try {
      const connectRes = await api.get<{ publicKey: string }>(Api.Wallet, '/auth/connect');
      const payload: Record<string, unknown> = {
        name: name.trim(),
        mode: 'independent',
        encrypted: await encryptPassword(password, connectRes.publicKey),
      };

      const res = await api.post<{ success: boolean; agent?: { id?: string } }>(
        Api.Wallet,
        '/agents/credential',
        payload,
      );

      // Save the agent password as a credential in primary agent's vault
      if (saveToVault && primaryAgentId) {
        try {
          await api.post(Api.Wallet, '/credentials', {
            agentId: primaryAgentId,
            name: `Agent: ${name.trim()}`,
            type: 'login',
            fields: [
              { key: 'username', value: name.trim(), type: 'text', sensitive: false },
              { key: 'password', value: password, type: 'secret', sensitive: true },
            ],
            meta: { tags: ['agent-password'] },
          });
        } catch (err) {
          console.error('[CreateAgentModal] failed to save password to vault:', err);
        }
      }

      handleClose();
      onCreated?.(res?.agent?.id);
    } catch (err) {
      console.error('[CreateAgentModal] error:', err);
    } finally {
      setCreating(false);
    }
  }, [name, password, saveToVault, primaryAgentId, handleClose, onCreated]);

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="New Agent"
        size="md"
        footer={(
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={handleClose}>
              CANCEL
            </Button>
            <Button
              size="sm"
              onClick={handleCreate}
              loading={creating}
              disabled={!name.trim() || password.length < 8}
            >
              CREATE
            </Button>
          </div>
        )}
      >
        <div className="space-y-4">
          <TextInput
            label="Agent Name"
            placeholder="e.g. Work, Personal"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {/* Agent Type — commented out for now
          <FilterDropdown
            label="Agent Type"
            options={AGENT_MODE_OPTIONS}
            value={mode}
            onChange={(value) => {
              const m = value as 'linked' | 'independent';
              setMode(m);
              if (m !== 'independent') setPassword('');
            }}
            compact
          />
          {mode === 'linked' && (
            <FilterDropdown
              label="Parent Agent"
              options={parentAgentOptions}
              value={parentId}
              onChange={setParentId}
              compact
            />
          )}
          */}
          <div>
            <div className="flex items-center justify-between mb-1.5 px-1">
              <label className="block font-mono text-[length:var(--font-size-xs)] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
                Agent Password
              </label>
              <button
                type="button"
                onClick={() => setShowPasswordGen(true)}
                className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
              >
                <Dices size={10} />
                Generate
              </button>
            </div>
            <TextInput
              type="password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {primaryAgentId && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={saveToVault}
                onChange={(e) => setSaveToVault(e.target.checked)}
                style={{ accentColor: 'var(--color-accent, #6366f1)' }}
              />
              <span className="font-mono text-[11px] text-[var(--color-text-muted,#6b7280)]">Save password to vault</span>
            </label>
          )}
        </div>
      </Modal>

      <PasswordGenerator
        isOpen={showPasswordGen}
        onClose={() => setShowPasswordGen(false)}
        onUse={(pw) => {
          setPassword(pw);
          setShowPasswordGen(false);
        }}
      />
    </>
  );
}
