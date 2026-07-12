import { NextRequest, NextResponse } from 'next/server';

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

export async function requireWorkspaceAdmin(
  request: NextRequest
): Promise<NextResponse | null> {
  const authHeader = request.headers.get('authorization');
  const isAdmin = await validateAdmin(authHeader);
  if (isAdmin) return null;

  return NextResponse.json(
    { success: false, error: 'Admin access required' },
    { status: 403 }
  );
}
