/**
 * Credential Import Route — POST /credentials/import
 * ====================================================
 *
 * Accepts CSV/1PUX file uploads and imports credentials into a agent.
 */

import { Request, Response, Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { requireWalletAuth } from '../middleware/auth';
import { requireAdminForRoute } from '../lib/permissions';
import { getCredentialAgentKey } from '../lib/credential-agent';
import { createCredential } from '../lib/credentials';
import { logEvent } from '../lib/logger';
import { getErrorMessage } from '../lib/error';
import { events } from '../lib/events';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';
import {
  parse1PasswordCSV,
  parse1PasswordJSON,
  parseBitwardenCSV,
  parseBitwardenJSON,
  parseICloudCSV,
  parseLastPassCSV,
  parseChromeCSV,
  parseChromeJSON,
  parseFirefoxCSV,
  parseFirefoxJSON,
  splitFields,
  detectDuplicates,
  ImportedCredential,
  ImportFormat,
} from '../lib/credential-import';

const router = Router();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const importRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ success: false, error: 'Import rate limited. Try again in 1 minute.' });
  },
});

// ---------------------------------------------------------------------------
// Auth + admin check
// ---------------------------------------------------------------------------

router.use(requireWalletAuth);
router.use(requireAdminForRoute(ESCALATION_ROUTE_IDS.IMPORT_ADMIN));

// Bypass rate limit in test/dev if configured
const bypassRateLimit = process.env.BYPASS_RATE_LIMIT === 'true' || process.env.NODE_ENV === 'test';
if (!bypassRateLimit) {
  router.use(importRateLimit);
}

// ---------------------------------------------------------------------------
// Supported formats and their parsers
// ---------------------------------------------------------------------------

const SUPPORTED_FORMATS: ImportFormat[] = [
  '1password-csv',
  '1password-json',
  'bitwarden-csv',
  'bitwarden-json',
  'icloud-csv',
  'lastpass-csv',
  'chrome-csv',
  'chrome-json',
  'firefox-csv',
  'firefox-json',
];

const SUPPORTED_SOURCES = ['1password', 'bitwarden', 'chrome', 'firefox', 'icloud', 'lastpass'] as const;
const SOURCE_FORMATS: Record<(typeof SUPPORTED_SOURCES)[number], ImportFormat[]> = {
  '1password': ['1password-csv', '1password-json'],
  bitwarden: ['bitwarden-csv', 'bitwarden-json'],
  icloud: ['icloud-csv'],
  lastpass: ['lastpass-csv'],
  chrome: ['chrome-csv', 'chrome-json'],
  firefox: ['firefox-csv', 'firefox-json'],
};

const BATCH_CAP = 1000;
const DRY_RUN_PREVIEW_LIMIT = 20;

// ---------------------------------------------------------------------------
// POST /credentials/import
// ---------------------------------------------------------------------------

router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const { source, format, agentId, dryRun, duplicateStrategy = 'skip' } = req.body;

    const normalizedSource = typeof source === 'string' ? source.toLowerCase() : undefined;

    // Validate duplicateStrategy
    const VALID_STRATEGIES = ['skip', 'rename', 'overwrite'];
    if (!VALID_STRATEGIES.includes(duplicateStrategy)) {
      res.status(400).json({
        success: false,
        error: `Invalid duplicateStrategy. Supported: ${VALID_STRATEGIES.join(', ')}`,
      });
      return;
    }

    // Validate dryRun shape
    if (
      dryRun !== undefined
      && dryRun !== true
      && dryRun !== false
      && dryRun !== 'true'
      && dryRun !== 'false'
    ) {
      res.status(400).json({
        success: false,
        error: 'dryRun must be a boolean or "true"/"false" string',
      });
      return;
    }

    // Validate source/format contract
    if (normalizedSource && !SOURCE_FORMATS[normalizedSource as keyof typeof SOURCE_FORMATS]) {
      res.status(400).json({
        success: false,
        error: `Invalid source. Supported: ${SUPPORTED_SOURCES.join(', ')}`,
      });
      return;
    }

    if (!format || !SUPPORTED_FORMATS.includes(format as ImportFormat)) {
      res.status(400).json({
        success: false,
        error: `Invalid format. Supported: ${SUPPORTED_FORMATS.join(', ')}`,
      });
      return;
    }

    if (
      normalizedSource
      && !SOURCE_FORMATS[normalizedSource as keyof typeof SOURCE_FORMATS].includes(format as ImportFormat)
    ) {
      res.status(400).json({
        success: false,
        error: `Format '${format}' is not supported for source '${normalizedSource}'`,
      });
      return;
    }

    if (!agentId) {
      res.status(400).json({ success: false, error: 'agentId is required' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded' });
      return;
    }

    // Defense-in-depth size check (multer also enforces this)
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    if (req.file.size > MAX_FILE_SIZE) {
      res.status(413).json({ success: false, error: `File too large (${(req.file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.` });
      return;
    }

    // Check agent is unlocked
    const agentKey = getCredentialAgentKey(agentId);
    if (!agentKey) {
      res.status(400).json({
        success: false,
        error: 'Agent must be unlocked before importing credentials',
      });
      return;
    }

    // Parse file
    let parsed: ImportedCredential[];
    let fileContent: string | null = req.file.buffer.toString('utf-8');

    try {
      try {
        switch (format as ImportFormat) {
          case '1password-csv':
            parsed = parse1PasswordCSV(fileContent);
            break;
          case 'bitwarden-csv':
            parsed = parseBitwardenCSV(fileContent);
            break;
          case 'icloud-csv':
            parsed = parseICloudCSV(fileContent);
            break;
          case 'lastpass-csv':
            parsed = parseLastPassCSV(fileContent);
            break;
          case 'chrome-csv':
            parsed = parseChromeCSV(fileContent);
            break;
          case 'firefox-csv':
            parsed = parseFirefoxCSV(fileContent);
            break;
          case '1password-json':
            parsed = parse1PasswordJSON(fileContent);
            break;
          case 'bitwarden-json':
            parsed = parseBitwardenJSON(fileContent);
            break;
          case 'chrome-json':
            parsed = parseChromeJSON(fileContent);
            break;
          case 'firefox-json':
            parsed = parseFirefoxJSON(fileContent);
            break;
          default:
            res.status(400).json({ success: false, error: `Format '${format}' not yet implemented` });
            return;
        }
      } catch (parseErr) {
        const parseMessage = getErrorMessage(parseErr);
        res.status(400).json({ success: false, error: `Invalid ${format} import payload: ${parseMessage}` });
        return;
      }
    } finally {
      // Memory cleanup
      fileContent = null;
      if (req.file) {
        (req.file as any).buffer = null;
      }
    }

    // Validate name lengths
    for (let i = 0; i < parsed.length; i++) {
      if (!parsed[i].name || parsed[i].name.length > 500) {
        res.status(400).json({
          success: false,
          error: `Row ${i + 1}: credential name is missing or exceeds 500 characters`,
        });
        return;
      }
    }

    // Batch cap
    if (parsed.length > BATCH_CAP) {
      res.status(400).json({
        success: false,
        error: `File contains ${parsed.length} credentials, exceeding the ${BATCH_CAP} limit`,
      });
      return;
    }

    // Detect duplicates
    const duplicates = detectDuplicates(parsed, agentId);

    // Dry-run mode
    const isDryRun = dryRun === 'true' || dryRun === true;
    if (isDryRun) {
      const preview = parsed.slice(0, DRY_RUN_PREVIEW_LIMIT).map((c, i) => ({
        name: c.name,
        type: c.type,
        url: c.url,
        fieldCount: c.fields.length,
        isDuplicate: duplicates.has(i),
        duplicateMatch: duplicates.get(i)?.matchType,
      }));

      res.json({
        success: true,
        total: parsed.length,
        duplicates: duplicates.size,
        credentials: preview,
      });
      return;
    }

    // Live import
    logEvent({
      category: 'system',
      action: 'credential-import-start',
      description: `Importing ${parsed.length} credentials from ${format}`,
      agentId: req.auth?.token?.agentId,
      metadata: { format, count: parsed.length, agentId },
    });

    let imported = 0;
    let skipped = 0;
    const errors: { row: number; reason: string }[] = [];

    for (let i = 0; i < parsed.length; i++) {
      const cred = parsed[i];
      const dup = duplicates.get(i);

      // Handle duplicates
      if (dup) {
        if (duplicateStrategy === 'skip') {
          skipped++;
          continue;
        } else if (duplicateStrategy === 'rename') {
          cred.name = `${cred.name} (imported)`;
        }
        // 'overwrite' (UI: "Allow Duplicates") — creates new entry alongside existing; does not replace
      }

      try {
        const { meta, sensitiveFields } = splitFields(cred.fields, cred.url, cred.tags);
        const created = createCredential(agentId, cred.type, cred.name, meta, sensitiveFields);
        events.credentialChanged({
          credentialId: created.id,
          credentialAgentId: created.agentId,
          change: 'created',
          actorType: 'admin',
          actorAgentId: req.auth?.token?.agentId,
          tokenHash: req.auth?.tokenHash,
          toLocation: 'active',
        });
        imported++;
      } catch (err) {
        errors.push({ row: i + 1, reason: getErrorMessage(err) });
      }
    }

    logEvent({
      category: 'system',
      action: 'credential-import-complete',
      description: `Imported ${imported}, skipped ${skipped}, errors ${errors.length}`,
      agentId: req.auth?.token?.agentId,
      metadata: { format, imported, skipped, errors: errors.length, agentId },
    });

    res.json({
      success: imported > 0 || errors.length === 0,
      imported,
      skipped,
      errors,
    });
  } catch (err) {
    logEvent({
      category: 'system',
      action: 'credential-import-failure',
      description: getErrorMessage(err),
      agentId: req.auth?.token?.agentId,
    });
    res.status(500).json({ success: false, error: getErrorMessage(err) });
  }
});

export default router;
