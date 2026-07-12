'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api, Api } from '@/lib/api';
import { CredentialField } from './CredentialField';

interface TOTPDisplayProps {
  credentialId: string;
}

/**
 * Live TOTP code display with countdown timer.
 * Only renders if the credential has a TOTP secret.
 */
export const TOTPDisplay: React.FC<TOTPDisplayProps> = ({ credentialId }) => {
  const [code, setCode] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(30);
  const [hasTOTP, setHasTOTP] = useState<boolean | null>(null); // null = unknown

  const fetchCode = useCallback(async () => {
    try {
      const res = await api.post<{ success: boolean; code: string; remaining: number; error?: string }>(
        Api.Wallet,
        `/credentials/${credentialId}/totp`,
      );
      if (res.success && res.code) {
        setCode(res.code);
        setRemaining(res.remaining);
        setHasTOTP(true);
      } else {
        setHasTOTP(false);
      }
    } catch {
      setHasTOTP(false);
    }
  }, [credentialId]);

  useEffect(() => {
    fetchCode();
  }, [fetchCode]);

  // Countdown timer
  useEffect(() => {
    if (hasTOTP !== true) return;
    const interval = setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) {
          fetchCode();
          return 30;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [hasTOTP, fetchCode]);

  if (hasTOTP === null || hasTOTP === false) return null;
  const isUrgent = remaining <= 5;
  const displayCode = code ? `${code.slice(0, 3)} ${code.slice(3)}` : '--- ---';
  const progress = remaining / 30;

  return (
    <div className="space-y-0.5" data-testid="totp-display">
      <CredentialField
        label="2FA Code"
        value={displayCode}
        copyValue={code ?? undefined}
        credentialId={credentialId}
        fieldKey="totp_code"
        isSensitive={false}
        trailingValue={(
          <div className="ml-2 flex items-center gap-1.5">
            <svg width="16" height="16" viewBox="0 0 18 18" className="shrink-0" style={{ transform: 'rotate(-90deg)' }}>
              <circle
                cx="9"
                cy="9"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-[var(--color-border,#d4d4d8)]"
                opacity="0.3"
              />
              <circle
                cx="9"
                cy="9"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={`${progress * 43.98} 43.98`}
                strokeLinecap="round"
                className={isUrgent ? 'text-[var(--color-danger,#ef4444)]' : 'text-[var(--color-accent,#ccff00)]'}
              />
            </svg>
            <span className={`font-mono text-[9px] ${
              isUrgent ? 'text-[var(--color-danger,#ef4444)]' : 'text-[var(--color-text-faint,#9ca3af)]'
            }`}>
              {remaining}s
            </span>
          </div>
        )}
        disableLargeType={true}
        onShowLargeType={() => {}}
      />
    </div>
  );
};
