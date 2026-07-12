/**
 * Auth client for validating tokens from Next.js
 * Calls the Express server's /auth/validate endpoint
 */

const WALLET_SERVER_URL = process.env.WALLET_SERVER_URL || 'http://localhost:4242';

export interface TokenValidationResult {
  valid: boolean;
  isAdmin?: boolean;
  tokenHash?: string;
  payload?: {
    agentId: string;
    permissions: string[];
    limits?: { fund?: number; send?: number; swap?: number };
    walletAccess?: string[];
    exp?: number;
  };
  error?: string;
}

/**
 * Validate a token by calling the Express server
 * @param token - The raw token string to validate
 * @returns Token validation result with payload if valid
 */
export async function validateToken(token: string): Promise<TokenValidationResult> {
  try {
    const response = await fetch(`${WALLET_SERVER_URL}/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      return { valid: false, error: `Server error: ${response.status}` };
    }

    return await response.json();
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Failed to validate token'
    };
  }
}

/**
 * Check if a token has a specific permission
 */
export function hasPermission(result: TokenValidationResult, permission: string): boolean {
  if (!result.valid || !result.payload) return false;
  if (result.isAdmin) return true;
  return result.payload.permissions.includes(permission);
}

/**
 * Check if a token has any of the required permissions
 */
export function hasAnyPermission(result: TokenValidationResult, permissions: string[]): boolean {
  if (!result.valid || !result.payload) return false;
  if (result.isAdmin) return true;
  return permissions.some(p => result.payload!.permissions.includes(p));
}

/**
 * Extract token from Authorization header
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

