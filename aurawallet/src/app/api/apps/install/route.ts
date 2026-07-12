import { NextRequest, NextResponse } from 'next/server';
import { installApp, removeApp } from '../../../../server/lib/app-installer';

const WALLET_API = process.env.WALLET_SERVER_URL || 'http://localhost:4242';

/**
 * Validate admin access with explicit token validation.
 * This must never trust public endpoints like GET /setup.
 */
async function validateAdmin(authHeader: string | null): Promise<boolean> {
  if (!authHeader) return false;
  const [scheme, token] = authHeader.trim().split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return false;

  try {
    const resp = await fetch(`${WALLET_API}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      cache: 'no-store',
    });
    if (!resp.ok) return false;
    const data = await resp.json() as { valid?: boolean; isAdmin?: boolean };
    return data.valid === true && data.isAdmin === true;
  } catch {
    return false;
  }
}

/**
 * POST /api/apps/install — Install a app from a source
 * Body: { source: string, name?: string, force?: boolean }
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const isAdmin = await validateAdmin(authHeader);
  if (!isAdmin) {
    return NextResponse.json(
      { success: false, error: 'Admin access required' },
      { status: 403 },
    );
  }

  try {
    const body = await req.json();
    const { source, name, force } = body;

    if (!source || typeof source !== 'string') {
      return NextResponse.json(
        { success: false, error: 'source is required' },
        { status: 400 },
      );
    }

    const result = installApp(source, { name, force });

    // Hot-reload: create token for the new app without restart
    try {
      await fetch(`${WALLET_API}/apps/${result.id}/reload`, {
        method: 'POST',
        headers: {
          Authorization: authHeader!,
          'Content-Type': 'application/json',
        },
      });
    } catch {
      // Non-critical — app will get a token on next server restart
    }

    return NextResponse.json({
      success: true,
      app: {
        id: result.id,
        name: result.name,
        source: result.source,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Install failed';
    return NextResponse.json(
      { success: false, error: message },
      { status: 400 },
    );
  }
}

/**
 * DELETE /api/apps/install — Remove an installed app
 * Body: { appId: string }
 */
export async function DELETE(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const isAdmin = await validateAdmin(authHeader);
  if (!isAdmin) {
    return NextResponse.json(
      { success: false, error: 'Admin access required' },
      { status: 403 },
    );
  }

  try {
    const body = await req.json();
    const { appId } = body;

    if (!appId || typeof appId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'appId is required' },
        { status: 400 },
      );
    }

    // Revoke the app's token via Express (separate process, holds token in memory)
    try {
      await fetch(`${WALLET_API}/apps/${appId}/approve`, {
        method: 'DELETE',
        headers: { Authorization: authHeader! },
      });
    } catch {
      // Non-critical if Express is down — token expires in 24h max
    }

    removeApp(appId);

    return NextResponse.json({ success: true, appId, removed: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Remove failed';
    return NextResponse.json(
      { success: false, error: message },
      { status: 400 },
    );
  }
}
