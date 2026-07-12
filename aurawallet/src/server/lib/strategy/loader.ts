/**
 * Strategy Manifest Loader
 *
 * Scans apps directory for strategy manifests (those with ticker or jobs field).
 * Uses the 'yaml' package for full YAML parsing (nested objects, multi-line strings).
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { StrategyManifest, SourceDef, TickTier, TICK_INTERVALS } from './types';
import { isIPv4, isIPv6 } from 'net';
import { isPrivateIp } from '../network';

const VALID_TICKERS = Object.keys(TICK_INTERVALS) as TickTier[];

/**
 * Load all strategy manifests from apps/ directory.
 * Only returns manifests with a ticker or jobs field (skips regular apps).
 */
export function loadStrategyManifests(): StrategyManifest[] {
  const appsDir = path.join(process.cwd(), 'apps');
  if (!fs.existsSync(appsDir)) return [];

  const strategies: StrategyManifest[] = [];

  for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mdPath = path.join(appsDir, entry.name, 'app.md');
    if (!fs.existsSync(mdPath)) continue;

    const raw = fs.readFileSync(mdPath, 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;

    let manifest: Record<string, unknown>;
    try {
      manifest = parseYaml(match[1]);
    } catch (err) {
      console.error(`[strategy] Failed to parse ${mdPath}:`, err);
      continue;
    }

    const hooks = manifest.hooks as StrategyManifest['hooks'] | undefined;
    if (!manifest || (!manifest.ticker && !manifest.jobs && !hooks?.message)) continue;

    const strategy: StrategyManifest = {
      id: entry.name,
      name: (manifest.name as string) || entry.name,
      icon: manifest.icon as string | undefined,
      category: manifest.category as string | undefined,
      size: manifest.size as string | undefined,
      autoStart: manifest.autoStart === true,
      ticker: manifest.ticker as TickTier | undefined,
      jobs: manifest.jobs as StrategyManifest['jobs'],
      sources: (manifest.sources as SourceDef[]) || [],
      keys: manifest.keys as StrategyManifest['keys'],
      hooks: manifest.hooks as StrategyManifest['hooks'] || { tick: '', execute: '' },
      config: (manifest.config as StrategyManifest['config']) || {},
      permissions: (manifest.permissions as string[]) || [],
      limits: manifest.limits as StrategyManifest['limits'],
      allowedHosts: deriveAllowedHosts(
        manifest.allowedHosts as string[] | undefined,
        (manifest.sources as SourceDef[]) || [],
      ),
    };

    const errors = validateManifest(strategy);
    if (errors.length > 0) {
      console.error(`[strategy] Invalid manifest ${entry.name}:`, errors);
      continue;
    }

    // Sort sources by dependency order
    strategy.sources = orderSources(strategy.sources);

    strategies.push(strategy);
  }

  return strategies;
}

/**
 * Validate a strategy manifest. Returns array of error strings (empty = valid).
 */
export function validateManifest(manifest: StrategyManifest): string[] {
  const errors: string[] = [];

  const hasTicker = !!manifest.ticker || !!manifest.jobs;
  const hasMessage = !!manifest.hooks?.message;

  // hooks.tick is required only when ticker or jobs is set
  if (hasTicker && !manifest.hooks?.tick) {
    errors.push('Missing hooks.tick (required when ticker or jobs is set)');
  }

  if (manifest.ticker && !VALID_TICKERS.includes(manifest.ticker)) {
    errors.push(`Invalid ticker "${manifest.ticker}". Must be one of: ${VALID_TICKERS.join(', ')}`);
  }

  if (manifest.jobs) {
    for (const job of manifest.jobs) {
      if (!job.id) errors.push('Job missing id');
      if (!job.ticker || !VALID_TICKERS.includes(job.ticker)) {
        errors.push(`Job "${job.id}" has invalid ticker "${job.ticker}"`);
      }
    }
  }

  if (!hasTicker && !hasMessage) {
    errors.push('Must have either ticker, jobs, or hooks.message');
  }

  // Validate allowedHosts — reject private IPs/hosts
  if (manifest.allowedHosts) {
    for (const host of manifest.allowedHosts) {
      if (isPrivateHost(host)) {
        errors.push(`allowedHosts contains private/reserved host: "${host}"`);
      }
    }
  }

  // Validate source URLs — reject private IPs/hosts at load time
  for (const source of manifest.sources) {
    if (!source.url.startsWith('/') && !source.url.includes('${')) {
      try {
        const parsed = new URL(source.url);
        if (isPrivateHost(parsed.hostname)) {
          errors.push(`Source "${source.id}" has private/reserved host in URL: "${parsed.hostname}"`);
        }
        if (manifest.allowedHosts && manifest.allowedHosts.length > 0 && !manifest.allowedHosts.includes(parsed.hostname)) {
          errors.push(`Source "${source.id}" host "${parsed.hostname}" is not listed in allowedHosts`);
        }
      } catch {
        // URL with template vars or invalid — validated at fetch time
      }
    }
    if (!source.url.startsWith('/') && source.url.includes('${') && (!manifest.allowedHosts || manifest.allowedHosts.length === 0)) {
      errors.push(`Source "${source.id}" uses a templated external URL and requires explicit allowedHosts`);
    }
  }

  // Validate source dependencies exist
  const sourceIds = new Set(manifest.sources.map(s => s.id));
  for (const source of manifest.sources) {
    if (source.depends && !sourceIds.has(source.depends)) {
      errors.push(`Source "${source.id}" depends on unknown source "${source.depends}"`);
    }
  }

  // Check for circular dependencies
  if (hasCircularDeps(manifest.sources)) {
    errors.push('Circular source dependencies detected');
  }

  return errors;
}

/**
 * Topological sort of sources by dependency order.
 * Independent sources come first, dependent sources come after their parents.
 */
export function orderSources(sources: SourceDef[]): SourceDef[] {
  if (sources.length === 0) return [];

  const byId = new Map(sources.map(s => [s.id, s]));
  const ordered: SourceDef[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // circular — already caught by validation
    visiting.add(id);

    const source = byId.get(id);
    if (!source) return;

    if (source.depends) {
      visit(source.depends);
    }

    visiting.delete(id);
    visited.add(id);
    ordered.push(source);
  }

  for (const source of sources) {
    visit(source.id);
  }

  return ordered;
}

/**
 * Derive the combined allowedHosts list from explicit YAML declaration
 * and auto-extracted hostnames from source URLs.
 */
function deriveAllowedHosts(
  explicit: string[] | undefined,
  sources: SourceDef[],
): string[] {
  const hosts = new Set(explicit || []);

  for (const source of sources) {
    // Skip internal URLs (start with /) and URLs with template vars
    if (source.url.startsWith('/') || source.url.includes('${')) continue;
    try {
      const parsed = new URL(source.url);
      hosts.add(parsed.hostname);
    } catch {
      // Skip unparseable URLs
    }
  }

  return hosts.size > 0 ? Array.from(hosts) : [];
}

/**
 * Check if a hostname string is obviously private (pre-DNS, for manifest validation).
 */
function isPrivateHost(hostname: string): boolean {
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', ''].includes(hostname)) return true;
  if (isIPv4(hostname) || isIPv6(hostname)) return isPrivateIp(hostname);
  return false;
}

/**
 * Check for circular dependencies in sources.
 */
function hasCircularDeps(sources: SourceDef[]): boolean {
  const byId = new Map(sources.map(s => [s.id, s]));
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function hasCycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);

    const source = byId.get(id);
    if (source?.depends) {
      if (hasCycle(source.depends)) return true;
    }

    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const source of sources) {
    if (hasCycle(source.id)) return true;
  }

  return false;
}
