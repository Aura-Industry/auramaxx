'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button, TextInput, FilterDropdown, Modal, Toggle } from '@/components/design-system';
import { WORDLIST } from '@/lib/wordlist';

interface PasswordGeneratorProps {
  isOpen: boolean;
  onClose: () => void;
  onUse: (password: string) => void;
}

type GenType = 'random' | 'memorable' | 'pin';

interface GenOptions {
  numbers: boolean;
  symbols: boolean;
  uppercase: boolean;
  avoidAmbiguous: boolean;
}

const TYPE_OPTIONS = [
  { value: 'random', label: 'Random' },
  { value: 'memorable', label: 'Memorable' },
  { value: 'pin', label: 'PIN' },
];

const DEFAULT_LENGTHS: Record<GenType, number> = { random: 20, memorable: 4, pin: 6 };
const MIN_LENGTHS: Record<GenType, number> = { random: 8, memorable: 3, pin: 4 };
const MAX_LENGTHS: Record<GenType, number> = { random: 128, memorable: 10, pin: 12 };

function randomIndex(max: number): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
}

function generateRandom(length: number, opts: GenOptions): string {
  let charset = 'abcdefghijklmnopqrstuvwxyz';
  if (opts.numbers) charset += '0123456789';
  if (opts.symbols) charset += '!@#$%^&*()_+-=[]{}|;:,.<>?';
  if (opts.uppercase) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (opts.avoidAmbiguous) charset = charset.replace(/[0OoIl1]/g, '');
  if (charset.length === 0) charset = 'abcdefghijklmnopqrstuvwxyz';
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    chars.push(charset[randomIndex(charset.length)]);
  }
  return chars.join('');
}

function generateMemorable(count: number): string {
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(WORDLIST[randomIndex(WORDLIST.length)]);
  }
  return words.join('-');
}

function generatePin(length: number): string {
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    chars.push(String(randomIndex(10)));
  }
  return chars.join('');
}

export const PasswordGenerator: React.FC<PasswordGeneratorProps> = ({ isOpen, onClose, onUse }) => {
  const [type, setType] = useState<GenType>('random');
  const [length, setLength] = useState(DEFAULT_LENGTHS.random);
  const [options, setOptions] = useState<GenOptions>({
    numbers: true,
    symbols: true,
    uppercase: true,
    avoidAmbiguous: false,
  });
  const [generated, setGenerated] = useState('');
  const [copied, setCopied] = useState(false);

  const generate = useCallback(() => {
    switch (type) {
      case 'random':
        setGenerated(generateRandom(length, options));
        break;
      case 'memorable':
        setGenerated(generateMemorable(length));
        break;
      case 'pin':
        setGenerated(generatePin(length));
        break;
    }
    setCopied(false);
  }, [type, length, options]);

  // Auto-generate on open and when options change
  useEffect(() => {
    if (isOpen) generate();
  }, [isOpen, generate]);

  // Reset length when type changes
  useEffect(() => {
    setLength(DEFAULT_LENGTHS[type]);
  }, [type]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(generated);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  const handleLengthInput = (val: string) => {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      setLength(Math.max(MIN_LENGTHS[type], Math.min(MAX_LENGTHS[type], n)));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Password Generator"
      size="sm"
      footer={(
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={generate} icon={<RotateCcw size={10} />}>
            Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => onUse(generated)}>
            Use
          </Button>
        </div>
      )}
    >
      <div className="space-y-4 min-h-[280px]">
        {/* Generated password display */}
        <div
          onClick={handleCopy}
          className="bg-[var(--color-background-alt,#f4f4f5)] border border-[var(--color-border,#d4d4d8)] p-3 cursor-pointer transition-colors hover:border-[var(--color-border-focus,#0a0a0a)] relative group"
        >
          <div className="font-mono text-lg font-bold text-[var(--color-text,#0a0a0a)] break-all select-all pr-12">
            {generated}
          </div>
          <div className={`absolute top-1 right-2 font-mono text-[8px] uppercase tracking-widest font-bold transition-opacity ${copied ? 'opacity-100' : 'opacity-0'} bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] px-1.5 py-0.5`}>
            Copied
          </div>
          {!copied && (
            <div className="absolute top-1 right-2 font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] opacity-0 group-hover:opacity-100 transition-opacity">
              Click to copy
            </div>
          )}
        </div>

        {/* Type selector */}
        <FilterDropdown
          options={TYPE_OPTIONS}
          value={type}
          onChange={(v) => setType(v as GenType)}
          label="Type"
          compact
        />

        {/* Length */}
        <div>
          <label className="block font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] mb-1.5 px-1">
            Length
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={MIN_LENGTHS[type]}
              max={MAX_LENGTHS[type]}
              value={length}
              onChange={(e) => setLength(parseInt(e.target.value, 10))}
              className="flex-1 h-1 appearance-none bg-[var(--color-border,#d4d4d8)] outline-none"
              style={{ accentColor: 'var(--color-accent, #ccff00)' }}
            />
            <div className="w-16">
              <TextInput
                compact
                type="number"
                min={MIN_LENGTHS[type]}
                max={MAX_LENGTHS[type]}
                value={length}
                onChange={(e) => handleLengthInput(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Options (only for random type) */}
        {type === 'random' && (
          <div className="space-y-2.5">
            <Toggle
              size="sm"
              checked={options.numbers}
              onChange={(v) => setOptions((o) => ({ ...o, numbers: v }))}
              label="Numbers"
            />
            <Toggle
              size="sm"
              checked={options.symbols}
              onChange={(v) => setOptions((o) => ({ ...o, symbols: v }))}
              label="Symbols"
            />
            <Toggle
              size="sm"
              checked={options.uppercase}
              onChange={(v) => setOptions((o) => ({ ...o, uppercase: v }))}
              label="Uppercase"
            />
            <Toggle
              size="sm"
              checked={options.avoidAmbiguous}
              onChange={(v) => setOptions((o) => ({ ...o, avoidAmbiguous: v }))}
              label="Avoid ambiguous"
            />
          </div>
        )}

      </div>
    </Modal>
  );
};
