'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Loader2 } from 'lucide-react';
import { APP_SDK_SOURCE } from '@/lib/app-sdk';
import { useAuth } from '@/context/AuthContext';
import { useWebSocket } from '@/context/WebSocketContext';
import { api, Api } from '@/lib/api';

interface ThirdPartyAppProps {
  config?: {
    appPath?: string;
    appName?: string;
    _refreshKey?: number;
  };
}

interface AppManifestSummary {
  id: string;
  name: string;
  permissions: string[];
}

interface AppManifestsResponse {
  success: boolean;
  manifests?: AppManifestSummary[];
}

/**
 * Collect CSS variables from the current document for theme injection.
 */
function collectCssVariables(): string {
  const vars: string[] = [];
  const computed = getComputedStyle(document.documentElement);
  const varNames = [
    '--color-background', '--color-background-alt', '--color-surface',
    '--color-surface-alt', '--color-text', '--color-text-muted',
    '--color-text-faint', '--color-border', '--color-border-muted',
    '--color-border-focus', '--color-accent', '--color-info',
    '--color-success', '--color-warning',
  ];
  for (const name of varNames) {
    const value = computed.getPropertyValue(name).trim();
    if (value) vars.push(`${name}: ${value};`);
  }
  return `:root { ${vars.join(' ')} }`;
}

/**
 * Build a default HTML page for headless apps (no index.html).
 */
function buildDefaultHtml(appName: string): string {
  const safeName = appName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<body>
  <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
    height:100vh;font-family:ui-monospace,monospace;color:var(--color-text-muted,#6b7280);">
    <div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;">${safeName}</div>
    <div style="font-size:8px;margin-top:4px;opacity:0.6;">HEADLESS APP — NO UI</div>
  </div>
</body>`;
}

/**
 * Build self-contained sandboxed HTML by inlining the app's index.html content.
 * The app HTML is fetched on the HOST side (React), then baked into a blob URL.
 * This avoids fetch() inside the sandbox (which has no origin to resolve against).
 *
 * Injects __AURA_TOKEN__, __AURA_API_BASE__, __AURA_APP_ID__ globals
 * so the SDK can make direct fetch() calls to the wallet API.
 */
function buildAppHtml(
  appHtml: string,
  themeStyles: string,
  appId: string,
  token: string | null,
): string {
  // Parse the app's HTML to extract styles, body, and scripts
  const parser = new DOMParser();
  const doc = parser.parseFromString(appHtml, 'text/html');

  // Collect <style> tags from app
  const appStyles: string[] = [];
  doc.querySelectorAll('style').forEach(s => {
    appStyles.push(s.textContent || '');
  });

  // Collect inline scripts (skip external src scripts — they can't load in sandbox)
  const appScripts: string[] = [];
  doc.querySelectorAll('script').forEach(s => {
    if (!s.src && s.textContent) {
      // Escape </script to prevent breaking out of our wrapper
      appScripts.push(s.textContent.replace(/<\/script/gi, '<\\/script'));
    }
  });

  // Remove script tags from body so they aren't included twice
  // (once in bodyContent and once in appScripts)
  doc.querySelectorAll('script').forEach(s => s.remove());
  const bodyContent = doc.body.innerHTML;

  // Escape token for safe embedding in script
  const safeToken = token ? token.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${themeStyles}</style>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: ui-monospace, monospace; overflow: auto; background: var(--color-surface, #fff); color: var(--color-text, #0a0a0a); }
</style>
${appStyles.map(s => `<style>${s}</style>`).join('\n')}
<script>
window.__AURA_TOKEN__ = "${safeToken}";
window.__AURA_API_BASE__ = "${api.getBaseUrl(Api.Wallet)}";
window.__AURA_APP_ID__ = "${appId}";
<\/script>
<script>${APP_SDK_SOURCE}<\/script>
</head>
<body>
${bodyContent}
${appScripts.map(s => `<script>${s}<\/script>`).join('\n')}
</body>
</html>`;
}

export default function ThirdPartyApp({ config }: ThirdPartyAppProps) {
  const appPath = config?.appPath;
  const refreshKey = config?._refreshKey;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalDetailsLoading, setApprovalDetailsLoading] = useState(false);
  const [approvalDetails, setApprovalDetails] = useState<AppManifestSummary | null>(null);
  const [approvalRefreshKey, setApprovalRefreshKey] = useState(0);
  const { token: authToken } = useAuth();
  const { subscribe } = useWebSocket();

  // Track active WS subscriptions so we can unsubscribe on unmount
  const subscriptionsRef = useRef<Map<string, () => void>>(new Map());

  // Helper: forward a WS event to the iframe as app:data postMessage
  const forwardToIframe = useCallback((channel: string, data: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'app:data', channel, data },
      '*',
    );
  }, []);

  // Auto-subscribe to app:emit for this app's custom events
  useEffect(() => {
    if (!appPath) return;
    const unsub = subscribe('app:emit' as any, (event: any) => {
      const d = event.data;
      if (d?.strategyId === appPath && d?.channel) {
        forwardToIframe(d.channel, d.data);
      }
    });
    return unsub;
  }, [appPath, subscribe, forwardToIframe]);

  // Backward compat: still forward strategy:tick as strategy:state postMessage
  useEffect(() => {
    if (!appPath) return;
    return subscribe('strategy:tick' as any, (event: any) => {
      const data = event.data;
      if (data?.strategyId === appPath && data?.state) {
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'strategy:state', state: data.state },
          '*',
        );
      }
    });
  }, [appPath, subscribe]);

  // Handle postMessage from the app iframe
  const handleMessage = useCallback((event: MessageEvent) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    // Only handle messages from our iframe
    const iframe = iframeRef.current;
    if (!iframe || event.source !== iframe.contentWindow) return;

    // Process app:open-url — iframe wants to open a link in the parent context
    if (msg.type === 'app:open-url' && typeof msg.url === 'string') {
      window.open(msg.url, '_blank', 'noopener');
      return;
    }

    // Process app:subscribe — iframe wants to receive a WS event channel
    if (msg.type === 'app:subscribe' && typeof msg.channel === 'string') {
      const channel: string = msg.channel;
      // Skip if already subscribed to this channel
      if (subscriptionsRef.current.has(channel)) return;

      const unsub = subscribe(channel as any, (wsEvent: any) => {
        forwardToIframe(channel, wsEvent.data);
      });
      subscriptionsRef.current.set(channel, unsub);
    }
  }, [subscribe, forwardToIframe]);

  // Listen for postMessage from app iframe
  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  // Cleanup all WS subscriptions on unmount
  useEffect(() => {
    const subs = subscriptionsRef.current;
    return () => {
      for (const unsub of subs.values()) {
        unsub();
      }
      subs.clear();
    };
  }, []);

  // Fetch app HTML and token on host side, build blob URL
  useEffect(() => {
    if (!appPath) return;

    let revoked = false;
    let url: string | null = null;

    setLoading(true);
    setError(null);
    setApprovalRequired(false);
    setApprovalError(null);
    setApprovalDetailsLoading(false);
    setApprovalDetails(null);

    (async () => {
      const loadApprovalDetails = async () => {
        if (revoked) return;
        setApprovalDetailsLoading(true);
        try {
          const manifestsRes = await fetch('/api/apps/manifests');
          if (!manifestsRes.ok) return;
          const manifestsData = await manifestsRes.json() as AppManifestsResponse;
          if (!manifestsData.success || !Array.isArray(manifestsData.manifests)) return;
          if (revoked) return;
          const match = manifestsData.manifests.find((m) => m.id === appPath);
          if (!match) return;
          const permissions = Array.isArray(match.permissions)
            ? match.permissions.filter((perm) => typeof perm === 'string')
            : [];
          setApprovalDetails({
            id: match.id,
            name: match.name || match.id,
            permissions,
          });
        } catch {
          // Keep approval card usable even if manifest metadata fails to load
        } finally {
          if (!revoked) setApprovalDetailsLoading(false);
        }
      };

      try {
        const htmlRes = await fetch(`/api/apps/static/${appPath}/index.html`);
        const html = htmlRes.ok
          ? await htmlRes.text()
          : buildDefaultHtml(config?.appName || appPath);

        let tokenRes: { success: boolean; token?: string };
        try {
          tokenRes = await api.get<{ success: boolean; token?: string }>(
            Api.Wallet, `/apps/${appPath}/token`
          );
        } catch (err) {
          const status = (err as Error & { status?: number }).status;
          const message = err instanceof Error ? err.message : 'Failed to fetch app token';
          if (status === 404 || message.includes('No token for app')) {
            if (!revoked) {
              setApprovalRequired(true);
              setBlobUrl(null);
              void loadApprovalDetails();
            }
            return;
          }
          throw err;
        }

        if (revoked) return;
        const token = tokenRes.token ?? null;
        if (!tokenRes.success || !token) {
          setApprovalRequired(true);
          setBlobUrl(null);
          void loadApprovalDetails();
          return;
        }
        const themeStyles = collectCssVariables();
        const fullHtml = buildAppHtml(html, themeStyles, appPath, token);
        const blob = new Blob([fullHtml], { type: 'text/html' });
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      } catch (err) {
        if (!revoked) {
          setBlobUrl(null);
          setError(err instanceof Error ? err.message : 'Failed to load app');
        }
      } finally {
        if (!revoked) setLoading(false);
      }
    })();

    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [appPath, refreshKey, authToken, approvalRefreshKey]);

  const handleApprove = useCallback(async () => {
    if (!appPath) return;
    setApprovalLoading(true);
    setApprovalError(null);
    try {
      await api.post<{ success: boolean; error?: string }>(Api.Wallet, `/apps/${appPath}/approve`);
      setApprovalRequired(false);
      setApprovalRefreshKey((k) => k + 1);
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : 'Failed to approve app');
    } finally {
      setApprovalLoading(false);
    }
  }, [appPath]);

  if (!appPath) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[100px] text-[var(--color-text-muted,#6b7280)]">
        <Box size={24} className="mb-2" />
        <span className="font-mono text-xs">NO APP CONFIGURED</span>
        <span className="font-mono text-[9px] text-[var(--color-text-faint,#9ca3af)] mt-1">
          Set config.appPath to load a app
        </span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[100px]">
        <Loader2 size={20} className="animate-spin text-[var(--color-text-faint,#9ca3af)] mb-2" />
        <span className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">LOADING APP...</span>
      </div>
    );
  }

  if (approvalRequired) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[100px] p-4">
        <Box size={20} className="mb-2 text-[var(--color-text-muted,#6b7280)]" />
        <span className="font-mono text-[9px] text-[var(--color-text,#0a0a0a)]">APP APPROVAL REQUIRED</span>
        <span className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] mt-1 text-center">
          This app needs approval before it can run.
        </span>
        <div className="w-full max-w-[280px] mt-3 px-2 py-2 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background-alt,#f4f4f5)]">
          <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">REQUESTED PERMISSIONS</div>
          {approvalDetailsLoading ? (
            <div className="flex items-center gap-1 mt-1">
              <Loader2 size={10} className="animate-spin text-[var(--color-text-faint,#9ca3af)]" />
              <span className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">Loading details...</span>
            </div>
          ) : approvalDetails?.permissions.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {approvalDetails.permissions.map((permission) => (
                <span
                  key={permission}
                  className="px-1.5 py-0.5 border border-[var(--color-border,#d4d4d8)] font-mono text-[8px] text-[var(--color-text,#0a0a0a)]"
                >
                  {permission}
                </span>
              ))}
            </div>
          ) : (
            <span className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">No explicit permissions listed.</span>
          )}
        </div>
        <button
          onClick={() => void handleApprove()}
          disabled={approvalLoading}
          className="mt-3 px-3 py-2 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)] font-mono text-[9px] tracking-widest text-[var(--color-text,#0a0a0a)] hover:border-[var(--color-border-focus,#0a0a0a)] disabled:opacity-50 disabled:cursor-default"
        >
          {approvalLoading ? 'APPROVING...' : 'APPROVE'}
        </button>
        {approvalError && (
          <span className="font-mono text-[8px] text-[var(--color-warning,#ff4d00)] mt-2 text-center">{approvalError}</span>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[100px] p-4">
        <Box size={20} className="mb-2 text-[var(--color-warning,#ff4d00)]" />
        <span className="font-mono text-[9px] text-[var(--color-warning,#ff4d00)]">FAILED TO LOAD APP</span>
        <span className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] mt-1 text-center">{error}</span>
      </div>
    );
  }

  if (!blobUrl) return null;

  return (
    <div className="relative h-full min-h-[100px]">
      {/* SECURITY: sandbox without allow-same-origin. allow-popups-outside-sandbox
          ensures links opened in new tabs are NOT sandboxed (so X.com etc. work). */}
      <iframe
        ref={iframeRef}
        src={blobUrl}
        sandbox="allow-scripts allow-popups allow-popups-outside-sandbox"
        title={config?.appName || appPath}
        className="w-full h-full border-0"
        style={{ minHeight: '100px' }}
      />
    </div>
  );
}
