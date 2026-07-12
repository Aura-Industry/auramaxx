'use client';

import React from 'react';
import { KeyRound, Flame, Shield, Database } from 'lucide-react';
import { Modal } from '@/components/design-system';
import { CREATABLE_VIEWS, type ViewDefinition } from '@/lib/view-registry';

const ICON_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  KeyRound,
  Flame,
  Shield,
  Database,
};

interface CreateViewModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (view: ViewDefinition) => void;
}

export function CreateViewModal({ open, onClose, onSelect }: CreateViewModalProps) {
  if (!open) return null;

  return (
    <Modal isOpen={open} title="Create View" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px 0' }}>
        {CREATABLE_VIEWS.map((view) => {
          const Icon = ICON_MAP[view.icon] || KeyRound;

          return (
            <button
              key={view.id}
              onClick={() => {
                onSelect(view);
                onClose();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.03)',
                color: 'white',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease',
                width: '100%',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)';
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.15)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)';
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.08)';
              }}
            >
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'rgba(99,102,241,0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Icon size={18} />
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: '14px' }}>{view.label}</div>
                {view.description && (
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>
                    {view.description}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
