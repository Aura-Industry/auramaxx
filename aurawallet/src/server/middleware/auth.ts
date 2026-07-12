import { Request, Response, NextFunction } from 'express';
import {
  validateToken,
  getTokenHash,
  AgentTokenPayload,
} from '../lib/auth';
import { isAdmin } from '../lib/permissions';
import { isRevoked } from '../lib/sessions';
import { logger } from '../lib/logger';

/**
 * Auth info attached to requests
 */
export interface AuthInfo {
  token: AgentTokenPayload;
  tokenHash: string;
  raw: string;
}

// Extend Express Request to include auth info
declare global {
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

/**
 * Middleware that requires a valid Bearer token for all requests.
 * Admin tokens are regular tokens with admin:* permission.
 * Attaches auth info to req.auth on success.
 */
export function requireWalletAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.authFailed('Missing authorization header', req.path);
    res.status(401).json({ error: 'Authorization header required' });
    return;
  }

  const rawToken = authHeader.slice(7);
  const token = validateToken(rawToken);

  if (!token) {
    logger.authFailed('Invalid or expired token', req.path);
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const tokenHash = getTokenHash(rawToken);

  if (isRevoked(tokenHash)) {
    logger.authFailed('Token revoked', req.path, { tokenHash });
    res.status(401).json({ error: 'Token has been revoked' });
    return;
  }

  // Attach auth info to request
  req.auth = {
    token,
    tokenHash,
    raw: rawToken,
  };

  next();
}

/**
 * Middleware that requires admin permissions.
 * Must be used after requireWalletAuth (needs req.auth).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  if (!isAdmin(req.auth)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
}

/**
 * Optional auth middleware - extracts token if present but doesn't require it.
 * Useful for routes that behave differently for authenticated vs unauthenticated users.
 */
export function optionalWalletAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No auth - continue without setting req.auth
    next();
    return;
  }

  const rawToken = authHeader.slice(7);
  const token = validateToken(rawToken);

  if (token) {
    const tokenHash = getTokenHash(rawToken);

    if (!isRevoked(tokenHash)) {
      req.auth = {
        token,
        tokenHash,
        raw: rawToken,
      };
    }
  }

  next();
}
