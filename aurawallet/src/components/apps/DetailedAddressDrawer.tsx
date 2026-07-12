'use client';

import React, { useState, useEffect } from 'react';
import { Copy, Edit2, Save, EyeOff, Eye, Flame } from 'lucide-react';
import { Drawer } from '@/components/design-system';

interface WalletData {
  address: string;
  tier: 'cold' | 'hot' | 'temp';
  chain: string;
  balance?: string;
  name?: string;
  color?: string;
  emoji?: string;
  description?: string;
  hidden?: boolean;
  tokenHash?: string;
  createdAt?: string;
}

interface DetailedAddressDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  wallet: WalletData | null;
  onUpdate: (address: string, updates: { name?: string; color?: string; emoji?: string; description?: string; hidden?: boolean }) => Promise<void>;
  onCopyAddress: (address: string) => void;
  copiedAddress: string | null;
}

const EMOJI_OPTIONS = ['🔥', '💎', '🚀', '⚡', '🌙', '🌟', '💰', '🎯', '🔮', '🌈'];
const COLOR_OPTIONS = ['#ff4d00', '#0047ff', '#00c853', '#ffab00', '#9c27b0', '#00bcd4', '#e91e63', '#607d8b'];

export const DetailedAddressDrawer: React.FC<DetailedAddressDrawerProps> = ({
  isOpen,
  onClose,
  wallet,
  onUpdate,
  onCopyAddress,
  copiedAddress,
}) => {
  const [isEditMode, setIsEditMode] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editEmoji, setEditEmoji] = useState('');
  const [editColor, setEditColor] = useState('');
  const [editHidden, setEditHidden] = useState(false);

  // Reset edit state when wallet changes
  useEffect(() => {
    if (wallet) {
      setEditName(wallet.name || '');
      setEditDescription(wallet.description || '');
      setEditEmoji(wallet.emoji || '');
      setEditColor(wallet.color || '');
      setEditHidden(wallet.hidden || false);
    }
    setIsEditMode(false);
  }, [wallet]);

  const handleSave = async () => {
    if (!wallet) return;
    setSaving(true);
    try {
      await onUpdate(wallet.address, {
        name: editName || undefined,
        description: editDescription || undefined,
        emoji: editEmoji || undefined,
        color: editColor || undefined,
        hidden: editHidden,
      });
      setIsEditMode(false);
    } finally {
      setSaving(false);
    }
  };

  if (!wallet) return null;

  const shortAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title={isEditMode ? 'EDIT WALLET' : 'WALLET DETAILS'}
      subtitle={shortAddress(wallet.address)}
      width="md"
    >
      <div className="space-y-5">
        {/* QR Code & Address */}
        <div className="bg-[var(--color-surface,#ffffff)] border border-[var(--color-border,#e5e5e5)] p-4">
          <div className="flex justify-center mb-4">
            <div className="p-2 bg-[var(--color-surface,#ffffff)] border border-[var(--color-border,#e5e5e5)] relative">
              <div className="absolute top-1 left-1 w-2 h-2 border-l border-t border-[var(--color-border-focus,#0a0a0a)]" />
              <div className="absolute top-1 right-1 w-2 h-2 border-r border-t border-[var(--color-border-focus,#0a0a0a)]" />
              <div className="absolute bottom-1 left-1 w-2 h-2 border-l border-b border-[var(--color-border-focus,#0a0a0a)]" />
              <div className="absolute bottom-1 right-1 w-2 h-2 border-r border-b border-[var(--color-border-focus,#0a0a0a)]" />
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${wallet.address}&bgcolor=ffffff&color=0a0a0a&margin=0`}
                alt="Wallet QR Code"
                className="w-28 h-28"
              />
            </div>
          </div>

          <div className="p-2 bg-[var(--color-text,#0a0a0a)] border border-[var(--color-border-focus,#0a0a0a)] mb-3">
            <code className="font-mono text-[10px] text-[var(--color-accent,#ccff00)] break-all select-all block text-center leading-relaxed">
              {wallet.address}
            </code>
          </div>

          <button
            onClick={() => onCopyAddress(wallet.address)}
            className="w-full py-2 bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] font-mono text-[9px] tracking-widest flex items-center justify-center gap-2 hover:text-[var(--color-accent,#ccff00)] transition-colors"
          >
            <Copy size={10} />
            {copiedAddress === wallet.address ? 'COPIED!' : 'COPY ADDRESS'}
          </button>
        </div>

        {/* Wallet Metadata */}
        <div className="bg-[var(--color-surface,#ffffff)] border border-[var(--color-border,#e5e5e5)] p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] tracking-widest">METADATA</div>
            <button
              onClick={() => isEditMode ? handleSave() : setIsEditMode(true)}
              disabled={saving}
              className="flex items-center gap-1 px-2 py-1 border border-[var(--color-border,#e5e5e5)] font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] hover:border-[var(--color-border-focus,#0a0a0a)] hover:text-[var(--color-text-hover,#0a0a0a)] transition-colors disabled:opacity-50"
            >
              {isEditMode ? (
                <>
                  <Save size={10} />
                  {saving ? 'SAVING...' : 'SAVE'}
                </>
              ) : (
                <>
                  <Edit2 size={10} />
                  EDIT
                </>
              )}
            </button>
          </div>

          {isEditMode ? (
            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest block mb-1">NAME</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Wallet name..."
                  className="w-full px-3 py-2 border border-[var(--color-border,#e5e5e5)] font-mono text-xs focus:outline-none focus:border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-surface,#ffffff)]"
                />
              </div>

              {/* Description */}
              <div>
                <label className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest block mb-1">DESCRIPTION</label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Add a description..."
                  rows={2}
                  className="w-full px-3 py-2 border border-[var(--color-border,#e5e5e5)] font-mono text-xs focus:outline-none focus:border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-surface,#ffffff)] resize-none"
                />
              </div>

              {/* Emoji Picker */}
              <div>
                <label className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest block mb-1">EMOJI</label>
                <div className="flex flex-wrap gap-1">
                  <button
                    onClick={() => setEditEmoji('')}
                    className={`w-8 h-8 border flex items-center justify-center transition-colors ${
                      !editEmoji ? 'border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-background-alt,#f4f4f5)]' : 'border-[var(--color-border,#e5e5e5)] hover:border-[var(--color-border-hover,#d4d4d4)]'
                    }`}
                  >
                    <Flame size={12} className="text-[var(--color-warning,#ff4d00)]" />
                  </button>
                  {EMOJI_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => setEditEmoji(emoji)}
                      className={`w-8 h-8 border flex items-center justify-center text-sm transition-colors ${
                        editEmoji === emoji ? 'border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-background-alt,#f4f4f5)]' : 'border-[var(--color-border,#e5e5e5)] hover:border-[var(--color-border-hover,#d4d4d4)]'
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Color Picker */}
              <div>
                <label className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest block mb-1">COLOR</label>
                <div className="flex flex-wrap gap-1">
                  <button
                    onClick={() => setEditColor('')}
                    className={`w-8 h-8 border flex items-center justify-center transition-colors ${
                      !editColor ? 'border-[var(--color-border-focus,#0a0a0a)]' : 'border-[var(--color-border,#e5e5e5)] hover:border-[var(--color-border-hover,#d4d4d4)]'
                    }`}
                  >
                    <div className="w-4 h-4 bg-[var(--color-border,#e5e5e5)] rounded-full" />
                  </button>
                  {COLOR_OPTIONS.map((color) => (
                    <button
                      key={color}
                      onClick={() => setEditColor(color)}
                      className={`w-8 h-8 border flex items-center justify-center transition-colors ${
                        editColor === color ? 'border-[var(--color-border-focus,#0a0a0a)]' : 'border-[var(--color-border,#e5e5e5)] hover:border-[var(--color-border-hover,#d4d4d4)]'
                      }`}
                    >
                      <div className="w-4 h-4 rounded-full" style={{ backgroundColor: color }} />
                    </button>
                  ))}
                </div>
              </div>

              {/* Hidden Toggle */}
              <div>
                <label className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest block mb-1">VISIBILITY</label>
                <button
                  onClick={() => setEditHidden(!editHidden)}
                  className={`flex items-center gap-2 px-3 py-2 border transition-colors w-full ${
                    editHidden
                      ? 'border-[var(--color-warning,#ff4d00)] bg-[var(--color-warning,#ff4d00)]/5 text-[var(--color-warning,#ff4d00)]'
                      : 'border-[var(--color-border,#e5e5e5)] hover:border-[var(--color-border-hover,#d4d4d4)]'
                  }`}
                >
                  {editHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                  <span className="font-mono text-[10px]">
                    {editHidden ? 'HIDDEN - Excluded from totals' : 'VISIBLE - Included in totals'}
                  </span>
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Display View */}
              <div className="flex items-center gap-3">
                {wallet.emoji ? (
                  <div className="w-10 h-10 border border-[var(--color-border,#e5e5e5)] flex items-center justify-center text-xl">
                    {wallet.emoji}
                  </div>
                ) : (
                  <div className="w-10 h-10 border border-[var(--color-warning,#ff4d00)]/30 flex items-center justify-center">
                    <Flame size={16} className="text-[var(--color-warning,#ff4d00)]" />
                  </div>
                )}
                <div className="flex-1">
                  <div className="font-bold text-sm text-[var(--color-text,#0a0a0a)]">
                    {wallet.name || 'Unnamed Wallet'}
                  </div>
                  {wallet.description && (
                    <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] mt-0.5">{wallet.description}</div>
                  )}
                </div>
                {wallet.color && (
                  <div
                    className="w-4 h-4 rounded-full border border-[var(--color-border,#e5e5e5)]"
                    style={{ backgroundColor: wallet.color }}
                  />
                )}
              </div>

              {wallet.hidden && (
                <div className="flex items-center gap-2 px-2 py-1.5 bg-[var(--color-warning,#ff4d00)]/10 border border-[var(--color-warning,#ff4d00)]/30">
                  <EyeOff size={10} className="text-[var(--color-warning,#ff4d00)]" />
                  <span className="font-mono text-[9px] text-[var(--color-warning,#ff4d00)]">HIDDEN</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Details Grid */}
        <div className="bg-[var(--color-surface,#ffffff)] border border-[var(--color-border,#e5e5e5)] p-4">
          <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] tracking-widest mb-3">DETAILS</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest">CREATED</div>
              <div className="font-mono text-[10px] text-[var(--color-text,#0a0a0a)] mt-0.5">
                {wallet.createdAt
                  ? new Date(wallet.createdAt).toLocaleDateString()
                  : 'Unknown'}
              </div>
            </div>
            <div>
              <div className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest">BALANCE</div>
              <div className="font-mono text-[10px] text-[var(--color-text,#0a0a0a)] mt-0.5 font-bold">
                {wallet.balance || '0 ETH'}
              </div>
            </div>
            <div>
              <div className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest">CHAIN</div>
              <div className="font-mono text-[10px] text-[var(--color-text,#0a0a0a)] mt-0.5 uppercase">
                {wallet.chain}
              </div>
            </div>
            <div>
              <div className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest">TIER</div>
              <div className="font-mono text-[10px] text-[var(--color-warning,#ff4d00)] mt-0.5 uppercase font-bold">
                {wallet.tier}
              </div>
            </div>
            {wallet.tokenHash && (
              <div className="col-span-2">
                <div className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest">CREATED BY</div>
                <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] mt-0.5 truncate">
                  {wallet.tokenHash.slice(0, 16)}...
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Drawer>
  );
};
