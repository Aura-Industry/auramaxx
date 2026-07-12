'use client';

import { useEffect, useRef } from 'react';
import { PriceProvider } from '@/context/PriceContext';
import { WebSocketProvider, useWebSocket } from '@/context/WebSocketContext';
import { WorkspaceProvider } from '@/context/WorkspaceContext';
import { AuthProvider, useAuth } from '@/context/AuthContext';

function ServerRestartBanner() {
  const { reconnected, dismissReconnected } = useWebSocket();
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (reconnected) {
      timerRef.current = setTimeout(dismissReconnected, 30000);
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }
  }, [reconnected, dismissReconnected]);

  if (!reconnected) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        fontFamily: 'monospace',
        fontSize: '11px',
        background: 'var(--color-warning, #ff4d00)',
        color: '#fff',
      }}
    >
      <span>
        Server restarted. All agent tokens have been invalidated. Agents will need to re-request access.
      </span>
      <button
        onClick={dismissReconnected}
        style={{
          background: 'rgba(255,255,255,0.2)',
          border: 'none',
          color: '#fff',
          padding: '4px 10px',
          cursor: 'pointer',
          fontFamily: 'monospace',
          fontSize: '10px',
          flexShrink: 0,
        }}
      >
        DISMISS
      </button>
    </div>
  );
}

// Inner component that uses the auth context
function AuthenticatedProviders({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();

  return (
    <WebSocketProvider token={token}>
      <PriceProvider>
        <WorkspaceProvider>
          <ServerRestartBanner />
          {children}
        </WorkspaceProvider>
      </PriceProvider>
    </WebSocketProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AuthenticatedProviders>{children}</AuthenticatedProviders>
    </AuthProvider>
  );
}
