import express from 'express';
import cors from 'cors';
import { createHash } from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { SERVER_PORT, ensureDataDir } from './lib/config';
import { unlock, hasColdWallet, autoUnlockLinkedAgents, isAgentUnlocked, getPrimaryAgentId } from './lib/cold';
import { ApprovalRouter, loadAdaptersFromDb } from './lib/adapters';
import { requestLogger } from './middleware/requestLogger';
import { logger } from './lib/logger';
import { log } from './lib/pino';
import { redactUrlQuery } from './lib/redaction';

// Routes
import setupRoutes from './routes/setup';
import unlockRoutes, { unlockPageHandler } from './routes/unlock';
import lockRoutes from './routes/lock';
import walletRoutes from './routes/wallet';
import sendRoutes from './routes/send';
import authRoutes from './routes/auth';
import passkeyRoutes from './routes/passkey';
import nukeRoutes from './routes/nuke';
import fundRoutes from './routes/fund';
import swapRoutes from './routes/swap';
import launchRoutes from './routes/launch';
import apikeysRoutes from './routes/apikeys';
import backupRoutes from './routes/backup';
import strategyRoutes from './routes/strategy';
import appRoutes from './routes/apps';
import actionsRoutes from './routes/actions';
import credentialAgentRoutes from './routes/credential-agents';
import agentHubRoutes from './routes/agent-hub';
import credentialsRoutes from './routes/credentials';
import agentProfilesRoutes from './routes/agent-profiles';
import credentialSharesRoutes from './routes/credential-shares';
import passkeyCredentialRoutes from './routes/passkey-credentials';
import importRoutes from './routes/import';
import adaptersRoutes, { setApprovalRouter, getApprovalRouter } from './routes/adapters';
import defaultsRoutes from './routes/defaults';
import aiRoutes from './routes/ai';
import portfolioRoutes from './routes/portfolio';
import resolveRoutes from './routes/resolve';
import priceRoutes from './routes/price';
import tokenRoutes from './routes/token';
import batchRoutes from './routes/batch';
import addressbookRoutes from './routes/addressbook';
import bookmarkRoutes from './routes/bookmarks';
import logsRoutes from './routes/logs';
import dashboardRoutes from './routes/dashboard';
import heartbeatRoutes from './routes/heartbeat';
import securityRoutes from './routes/security';
import flagsRoutes from './routes/flags';
import viewsRoutes from './routes/views';
import socialRoutes from './routes/social';
import verifiedCredentialRoutes from './routes/verified-credentials';
import { preloadCache, onDefaultChanged, parseRateLimit, getDefaultSync } from './lib/defaults';
import { SocketServer } from './cli/socket';

// Ensure data directory exists
ensureDataDir();

const app = express();

// Middleware
// Restrict CORS to localhost origins. Bearer token is the primary auth mechanism,
// but limiting origins provides defense-in-depth.
const ALLOWED_ORIGINS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/[a-z0-9-]+\.auramaxx\.xyz$/, // Cloudflare tunnel subdomains
  'null', // blob URL iframes have opaque origin "null"
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g., server-to-server, curl, mobile apps)
    if (!origin) return callback(null, true);
    if (origin === 'null') return callback(null, true);
    if (ALLOWED_ORIGINS.some(p => p instanceof RegExp ? p.test(origin) : p === origin)) {
      return callback(null, true);
    }
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
}));
app.use(express.json());

// Rate limiting — set BYPASS_RATE_LIMIT=true to disable (useful for local dev)
const bypassRateLimit = process.env.BYPASS_RATE_LIMIT === 'true';

const rateLimitResponse = (_req: express.Request, res: express.Response) => {
  res.status(429).json({ success: false, error: 'Too many requests, please try again later' });
};

const noopMiddleware: express.RequestHandler = (_req, _res, next) => next();

// Hot-reloadable rate limiter: wraps a mutable inner limiter that gets swapped on config change
function createHotLimiter(
  defaultKey: string,
  fallback: string,
): express.RequestHandler {
  if (bypassRateLimit) return noopMiddleware;

  const { max, windowMs } = parseRateLimit(getDefaultSync(defaultKey, fallback));
  let inner = rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, handler: rateLimitResponse });

  onDefaultChanged(defaultKey, (_key, value) => {
    const updated = parseRateLimit(value);
    inner = rateLimit({ windowMs: updated.windowMs, max: updated.max, standardHeaders: true, legacyHeaders: false, handler: rateLimitResponse });
  });

  return (req, res, next) => inner(req, res, next);
}

// Strict limit for password/setup endpoints (brute force protection)
const authBruteForceLimit = createHotLimiter('rate.brute_force', '5,900000');

// Registration/token request limit
const authRequestLimit = createHotLimiter('rate.auth_request', '10,60000');

// Transaction endpoints - keyed by hashed Bearer token
const txLimit = bypassRateLimit ? noopMiddleware : rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      // Hash the token so plaintext tokens are never stored in the rate limit memory store
      return createHash('sha256').update(authHeader.slice(7)).digest('hex').slice(0, 16);
    }
    return req.ip || 'unknown';
  },
  handler: rateLimitResponse,
});

// Paths that already have specific rate limits (skip general limit to avoid double-counting)
const rateLimitedPaths = new Set(['/unlock', '/setup', '/auth', '/send', '/swap', '/fund', '/launch', '/actions', '/nuke']);

// General rate limit for all other endpoints
const generalLimit = bypassRateLimit ? noopMiddleware : rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => rateLimitedPaths.has('/' + req.path.split('/')[1]),
  handler: rateLimitResponse,
});

// Request/response logging (structured, with timing, agent identification, and event storage)
app.use(requestLogger);

// Serve unlock page before rate limiting (GET is not a brute force vector)
app.get('/unlock', unlockPageHandler);

// Apply rate limits to specific routes before general middleware
if (bypassRateLimit) {
  log.warn('Rate limiting BYPASSED (BYPASS_RATE_LIMIT=true)');
}
// NOTE: Rate limiting assumes direct connections (no reverse proxy).
// If deploying behind a proxy, set app.set('trust proxy', 1) and configure accordingly.
app.use('/unlock', authBruteForceLimit);
// Only brute-force-limit setup writes; GET /setup (status check) uses the general limiter
app.use('/setup', (req, res, next) => {
  if (req.method === 'GET') return next();
  return authBruteForceLimit(req, res, next);
});
app.use('/actions', authBruteForceLimit);
app.use('/nuke', authBruteForceLimit);
// Only brute-force-limit backup writes; GET /backup (list) uses the general limiter
app.use('/backup', (req, res, next) => {
  if (req.method === 'GET') return next();
  return authBruteForceLimit(req, res, next);
});
app.use('/auth', authRequestLimit);
app.use('/send', txLimit);
app.use('/swap', txLimit);
app.use('/fund', txLimit);
app.use('/launch', txLimit);

// General rate limit for everything else
app.use(generalLimit);

// Routes
app.use('/setup', setupRoutes);
app.use('/unlock', unlockRoutes);
app.use('/lock', lockRoutes);
app.use('/wallets', walletRoutes);
app.use('/wallet', walletRoutes);
app.use('/send', sendRoutes);
app.use('/auth', authRoutes);
app.use('/auth/passkey', passkeyRoutes);
app.use('/nuke', nukeRoutes);
app.use('/fund', fundRoutes);
app.use('/swap', swapRoutes);
app.use('/launch', launchRoutes);
app.use('/apikeys', apikeysRoutes);
app.use('/backup', backupRoutes);
app.use('/strategies', strategyRoutes);
app.use('/apps', appRoutes);
app.use('/actions', actionsRoutes);
app.use('/agents/credential', credentialAgentRoutes);
app.use('/agent-hub', agentHubRoutes);
app.use('/credentials/import', importRoutes);
app.use('/credentials/passkey', passkeyCredentialRoutes);
app.use('/credentials', credentialsRoutes);
app.use('/agent-profiles', agentProfilesRoutes);
app.use('/credential-shares', credentialSharesRoutes);
app.use('/adapters', adaptersRoutes);
app.use('/defaults', defaultsRoutes);
app.use('/ai', aiRoutes);
app.use('/portfolio', portfolioRoutes);
app.use('/resolve', resolveRoutes);
app.use('/price', priceRoutes);
app.use('/token', tokenRoutes);
app.use('/batch', batchRoutes);
app.use('/address-labels', addressbookRoutes);
app.use('/bookmarks', bookmarkRoutes);
app.use('/security', securityRoutes);
app.use('/flags', flagsRoutes);
app.use('/views', viewsRoutes);
app.use('/social', socialRoutes);
app.use('/verified-credentials', verifiedCredentialRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/logs', logsRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/what_is_happening', heartbeatRoutes);

// Catch-all 404 — return JSON instead of Express default HTML
app.use((_req: express.Request, res: express.Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const safeUrl = redactUrlQuery(req.originalUrl || req.path);
  log.error({ err, method: req.method, url: safeUrl, agentId: req.auth?.token?.agentId }, 'server error');
  logger.error(err.message, safeUrl, {
    method: req.method,
    agentId: req.auth?.token?.agentId,
  });
  res.status(500).json({ error: 'Internal server error' });
});

// Auto-migrate database on startup (applies any pending Prisma migrations)
async function autoMigrate() {
  const { execSync } = await import('child_process');
  const dbUrl = process.env.DATABASE_URL;
  try {
    execSync('npx prisma migrate deploy', {
      cwd: import.meta.dirname ? import.meta.dirname + '/..' : process.cwd(),
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'pipe',
    });
    log.info('Database migrations applied');
  } catch (err) {
    log.warn({ err }, 'Database migration failed (may already be up to date)');
  }
}

// Start server (preload defaults cache before listening)
let server: ReturnType<typeof app.listen>;
let socketServer: SocketServer | null = null;

async function startServer() {
  // Apply pending migrations before anything else
  await autoMigrate();

  // One-time migration: agent-profiles.json → Prisma AgentProfile table
  try {
    const { migrateAgentProfilesToPrisma } = await import('./lib/migrate-agent-profiles');
    await migrateAgentProfilesToPrisma();
  } catch (err) {
    log.warn({ err }, 'Agent profile migration failed (non-fatal)');
  }

  // Load system defaults into memory cache before handling any requests
  await preloadCache().catch(err => {
    log.warn({ err }, 'Failed to preload defaults cache (will use seed values)');
  });

  // Seed default views for experimental wallet shell (no-op when flag is off)
  try {
    const { seedDefaultViews } = await import('./lib/view-registry');
    seedDefaultViews();
  } catch (err) {
    log.warn({ err }, 'view registry seed failed');
  }

  // Session crash recovery and log cleanup (before starting engine)
  try {
    const { recoverCrashedSessions, cleanupOldLogs } = await import('./lib/strategy/session-logger');
    await recoverCrashedSessions().catch(err => log.warn({ err }, 'session crash recovery failed'));
    await cleanupOldLogs().catch(err => log.warn({ err }, 'session log cleanup failed'));
  } catch (err) {
    log.warn({ err }, 'session logger import failed');
  }

  // Credential lifecycle retention: purge recently deleted credentials older than retention window.
  try {
    const { purgeDeletedCredentials } = await import('./lib/credentials');
    const summary = purgeDeletedCredentials(30);
    if (summary.purged > 0) {
      log.info({ purged: summary.purged, scanned: summary.scanned }, 'Purged expired recently deleted credentials on startup');
    }
    if (summary.errors.length > 0) {
      log.warn({ errors: summary.errors, scanned: summary.scanned }, 'Credential startup purge completed with errors');
    }
  } catch (err) {
    log.warn({ err }, 'Credential startup purge failed');
  }

  // Auto-unlock primary agent if AGENT_PASSWORD env var is set
  if (process.env.AGENT_PASSWORD) {
    if (!hasColdWallet()) {
      log.error('AGENT_PASSWORD is set but no agent exists. Run setup first.');
      process.exit(1);
    }
    const ok = unlock(process.env.AGENT_PASSWORD);
    if (!ok) {
      log.error('AGENT_PASSWORD is incorrect. Exiting.');
      process.exit(1);
    }
    delete process.env.AGENT_PASSWORD;
    log.info('Agent auto-unlocked via AGENT_PASSWORD env var');
  }

  // Auto-unlock linked agents when primary is already unlocked (e.g. via AGENT_PASSWORD).
  // Independent agents remain locked until explicitly unlocked with their own password.
  const pid = getPrimaryAgentId();
  if (pid && isAgentUnlocked(pid)) {
    try {
      const count = autoUnlockLinkedAgents();
      if (count > 0) {
        log.info({ count }, 'Auto-unlocked linked agents on startup');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to auto-unlock linked agents');
    }
  } else {
    log.debug('Primary agent not unlocked yet — deferring linked agent auto-unlock');
  }

  server = app.listen(SERVER_PORT, '127.0.0.1', () => {
    log.info({ port: SERVER_PORT, url: `http://127.0.0.1:${SERVER_PORT}` }, 'Aura Wallet server started');

    // Start local Unix socket broker as part of normal server lifecycle.
    socketServer = new SocketServer({ serverUrl: `http://127.0.0.1:${SERVER_PORT}` });
    socketServer.start()
      .then(() => {
        if (!socketServer) return;
        log.info({ socketPath: socketServer.getSocketPath() }, 'Local socket broker started');
      })
      .catch((err) => {
        log.error({ err }, 'Failed to start local socket broker');
      });

    // Start approval adapter router (if configured in DB)
    loadAdaptersFromDb().then(adapters => {
      if (adapters.length > 0) {
        const router = new ApprovalRouter(`http://127.0.0.1:${SERVER_PORT}`);
        for (const adapter of adapters) {
          router.registerAdapter(adapter);
        }
        setApprovalRouter(router);
        router.start().catch(err =>
          log.error({ err }, 'Failed to start approval router')
        );
        log.info({ count: adapters.length }, 'Approval adapters loaded');
      }
    }).catch(err => {
      log.error({ err }, 'Failed to load adapters from DB');
    });

    // Daily summary generation (hourly + on boot)
    import('./lib/strategy/session-logger').then(({ generateDailySummary }) => {
      generateDailySummary().catch(() => {});
      setInterval(() => generateDailySummary().catch(() => {}), 3_600_000);
    }).catch(() => {});
  });
}

startServer().catch(err => {
  log.error({ err }, 'Failed to start server');
  process.exit(1);
});

// Graceful shutdown
async function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down...');
  try {
    const { endAllActiveSessions } = await import('./lib/strategy/session-logger');
    await endAllActiveSessions('completed').catch(() => {});
  } catch {}
  try {
    if (socketServer) {
      await socketServer.stop();
      socketServer = null;
      log.info('Local socket broker stopped');
    }
  } catch (err) {
    log.error({ err }, 'Error stopping local socket broker');
  }
  try {
    const router = getApprovalRouter();
    if (router) await router.stop();
  } catch (err) {
    log.error({ err }, 'Error stopping approval router');
  }
  server.close(() => {
    log.info('HTTP server closed');
    process.exit(0);
  });
  // Force exit after 35s if graceful shutdown hangs
  setTimeout(() => process.exit(1), 35_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', async (err) => {
  log.fatal({ err }, 'Uncaught exception');
  try {
    const { markAllSessionsCrashed } = await import('./lib/strategy/session-logger');
    await markAllSessionsCrashed();
  } catch {}
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Unhandled rejection');
});

export default app;
