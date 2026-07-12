/**
 * Server-generated verified summaries for human action approval.
 *
 * Agents control the `summary` text shown to humans, but the server has the actual
 * action parameters (endpoint, body, amounts, recipients). This module generates
 * a trustworthy summary from the pre-computed action, detects discrepancies between
 * the agent's claim and the actual action, and flags mismatches.
 */

import { ethers } from 'ethers';
import { isSolanaChain, getNativeCurrency } from './address';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface VerifiedFact {
  label: string;
  value: string;
  /** Raw value for programmatic use (e.g., BigInt amount string) */
  raw?: string;
}

export interface SummaryDiscrepancy {
  field: string;
  agentClaim: string;
  actual: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface VerifiedSummary {
  /** Endpoint being called, e.g. "/swap" */
  action: string;
  /** Human-readable one-liner generated from actual action params */
  oneLiner: string;
  /** Structured facts extracted from the action body */
  facts: VerifiedFact[];
  /** Human-readable permission labels */
  permissionLabels: string[];
  /** Human-readable limit labels (reserved for v2; intentionally empty in v1) */
  limitLabels: string[];
  /** Human-readable wallet access labels */
  walletAccessLabels: string[];
  /** TTL label */
  ttlLabel: string;
  /** Agent ID that requested this action */
  agentId: string;
  /** Discrepancies between agent summary and actual action */
  discrepancies: SummaryDiscrepancy[];
  /** True if no critical discrepancies found */
  verified: boolean;
  /** ISO timestamp of when this summary was generated */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Permission labels
// ---------------------------------------------------------------------------

export const PERMISSION_LABELS: Record<string, string> = {
  'swap': 'Can swap tokens via DEX',
  'send:hot': 'Can send from hot wallets',
  'send:temp': 'Can send from temp wallets',
  'fund': 'Can transfer cold → hot',
  'launch': 'Can launch tokens',
  'wallet:create:hot': 'Can create hot wallets',
  'wallet:create:temp': 'Can create temp wallets',
  'wallet:export': 'Can export private keys',
  'wallet:list': 'Can list wallets',
  'wallet:rename': 'Can rename wallets',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr || 'unknown';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatAmount(amountRaw: string | undefined, chain: string | undefined): { display: string; ethValue: number } {
  if (!amountRaw) return { display: 'unknown', ethValue: 0 };

  const isSol = chain ? isSolanaChain(chain) : false;
  const symbol = chain ? getNativeCurrency(chain) : 'ETH';

  try {
    if (isSol) {
      // Lamports → SOL (1 SOL = 1e9 lamports)
      const solValue = Number(BigInt(amountRaw)) / 1e9;
      return { display: `${solValue} ${symbol}`, ethValue: solValue };
    }

    // EVM amounts are always in wei
    const amt = BigInt(amountRaw);
    const ethValue = parseFloat(ethers.formatEther(amt));
    return { display: `${ethers.formatEther(amt)} ${symbol}`, ethValue };
  } catch {
    // Fall through
  }

  return { display: `${amountRaw}`, ethValue: 0 };
}

function formatPermissionLabel(perm: string): string {
  return PERMISSION_LABELS[perm] || perm;
}

function formatTtl(ttl: number | undefined): string {
  if (!ttl) return 'Default';
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
  return `${Math.floor(ttl / 3600)}h`;
}

// ---------------------------------------------------------------------------
// Per-endpoint fact extraction
// ---------------------------------------------------------------------------

interface ActionInput {
  endpoint?: string;
  method?: string;
  body?: Record<string, unknown>;
}

function extractSwapFacts(body: Record<string, unknown>): { facts: VerifiedFact[]; oneLiner: string } {
  const from = body.from as string | undefined;
  const token = body.token as string | undefined;
  const direction = (body.direction as string) || 'buy';
  const amount = body.amount as string | undefined;
  const slippage = body.slippage as number | undefined;
  const chain = (body.chain as string) || 'base';
  const dex = body.dex as string | undefined;

  const { display: amountDisplay } = formatAmount(amount, chain);
  const symbol = getNativeCurrency(chain);

  const facts: VerifiedFact[] = [];
  if (from) facts.push({ label: 'From wallet', value: shortAddr(from), raw: from });
  if (token) facts.push({ label: 'Token', value: shortAddr(token), raw: token });
  facts.push({ label: 'Direction', value: direction });
  if (amount) facts.push({ label: 'Amount', value: amountDisplay, raw: amount });
  if (slippage !== undefined) facts.push({ label: 'Slippage', value: `${slippage}%` });
  facts.push({ label: 'Chain', value: chain });
  if (dex) facts.push({ label: 'DEX', value: dex });

  const tokenDisplay = token ? shortAddr(token) : 'token';
  const oneLiner = direction === 'sell'
    ? `Sell ${tokenDisplay} for ${amountDisplay} on ${chain}`
    : `Buy ${tokenDisplay} with ${amountDisplay} on ${chain}`;

  return { facts, oneLiner };
}

function extractSendFacts(body: Record<string, unknown>): { facts: VerifiedFact[]; oneLiner: string } {
  const from = body.from as string | undefined;
  const to = body.to as string | undefined;
  const amount = body.amount as string | undefined;
  const chain = (body.chain as string) || 'base';
  const hasRawTx = !!body.transaction;

  const { display: amountDisplay } = formatAmount(amount, chain);

  const facts: VerifiedFact[] = [];
  if (from) facts.push({ label: 'From', value: shortAddr(from), raw: from });
  if (to) facts.push({ label: 'To', value: shortAddr(to), raw: to });
  if (amount) facts.push({ label: 'Amount', value: amountDisplay, raw: amount });
  facts.push({ label: 'Chain', value: chain });
  if (hasRawTx) facts.push({ label: 'Raw transaction', value: 'Yes (Solana)' });

  const toDisplay = to ? shortAddr(to) : 'unknown';
  const oneLiner = hasRawTx
    ? `Send raw transaction to ${toDisplay} on ${chain}`
    : `Send ${amountDisplay} to ${toDisplay} on ${chain}`;

  return { facts, oneLiner };
}

function extractFundFacts(body: Record<string, unknown>): { facts: VerifiedFact[]; oneLiner: string } {
  const to = body.to as string | undefined;
  const amount = body.amount as string | undefined;
  const chain = (body.chain as string) || 'base';

  const { display: amountDisplay } = formatAmount(amount, chain);

  const facts: VerifiedFact[] = [];
  if (to) facts.push({ label: 'To wallet', value: shortAddr(to), raw: to });
  if (amount) facts.push({ label: 'Amount', value: amountDisplay, raw: amount });
  facts.push({ label: 'Chain', value: chain });

  const toDisplay = to ? shortAddr(to) : 'unknown';
  const oneLiner = `Fund ${toDisplay} with ${amountDisplay} from cold`;

  return { facts, oneLiner };
}

function extractLaunchFacts(body: Record<string, unknown>): { facts: VerifiedFact[]; oneLiner: string } {
  const from = body.from as string | undefined;
  const name = body.name as string | undefined;
  const symbol = body.symbol as string | undefined;
  const type = body.type as string | undefined;
  const chain = (body.chain as string) || 'base';

  const facts: VerifiedFact[] = [];
  if (from) facts.push({ label: 'From wallet', value: shortAddr(from), raw: from });
  if (name) facts.push({ label: 'Token name', value: name });
  if (symbol) facts.push({ label: 'Symbol', value: symbol });
  if (type) facts.push({ label: 'Launch type', value: type });
  facts.push({ label: 'Chain', value: chain });

  const tokenName = symbol || name || 'token';
  const launchType = type || 'standard';
  const oneLiner = `Launch ${tokenName} via ${launchType} on ${chain}`;

  return { facts, oneLiner };
}

function extractWalletCreateFacts(body: Record<string, unknown>): { facts: VerifiedFact[]; oneLiner: string } {
  const tier = (body.tier as string) || 'hot';
  const chain = (body.chain as string) || 'base';
  const name = body.name as string | undefined;

  const facts: VerifiedFact[] = [];
  facts.push({ label: 'Tier', value: tier });
  facts.push({ label: 'Chain', value: chain });
  if (name) facts.push({ label: 'Name', value: name });

  const oneLiner = `Create ${tier} wallet on ${chain}`;

  return { facts, oneLiner };
}

function extractFacts(action: ActionInput | undefined): { facts: VerifiedFact[]; oneLiner: string; endpoint: string } {
  if (!action?.endpoint) {
    return { facts: [], oneLiner: 'Action (no endpoint specified)', endpoint: 'unknown' };
  }

  const endpoint = action.endpoint;
  const body = action.body || {};

  if (endpoint.startsWith('/swap')) {
    const result = extractSwapFacts(body);
    return { ...result, endpoint };
  }
  if (endpoint.startsWith('/send')) {
    const result = extractSendFacts(body);
    return { ...result, endpoint };
  }
  if (endpoint.startsWith('/fund')) {
    const result = extractFundFacts(body);
    return { ...result, endpoint };
  }
  if (endpoint.startsWith('/launch')) {
    const result = extractLaunchFacts(body);
    return { ...result, endpoint };
  }
  if (endpoint.startsWith('/wallet/create')) {
    const result = extractWalletCreateFacts(body);
    return { ...result, endpoint };
  }

  // Unknown endpoint
  const method = action.method || 'POST';
  return {
    facts: [{ label: 'Endpoint', value: `${method} ${endpoint}` }],
    oneLiner: `${method} ${endpoint} (unverified)`,
    endpoint,
  };
}

// ---------------------------------------------------------------------------
// Discrepancy detection
// ---------------------------------------------------------------------------

const AMOUNT_REGEX = /(\d+\.?\d*)\s*(ETH|SOL|eth|sol)/;
const ACTION_WORDS: Record<string, string[]> = {
  '/swap': ['swap', 'buy', 'sell', 'trade', 'exchange'],
  '/send': ['send', 'transfer'],
  '/fund': ['fund', 'deposit'],
  '/launch': ['launch', 'deploy', 'create token', 'mint'],
  '/wallet/create': ['create wallet', 'new wallet'],
};

export function detectDiscrepancies(
  agentSummary: string,
  action: ActionInput | undefined,
  permissions: string[] | undefined,
): SummaryDiscrepancy[] {
  const discrepancies: SummaryDiscrepancy[] = [];

  if (!action?.endpoint) return discrepancies;

  const body = action.body || {};
  const endpoint = action.endpoint;
  const summaryLower = agentSummary.toLowerCase();

  // 1. Amount mismatch
  const amountMatch = AMOUNT_REGEX.exec(agentSummary);
  if (amountMatch && body.amount) {
    const claimedAmount = parseFloat(amountMatch[1]);
    const chain = (body.chain as string) || 'base';
    const { ethValue: actualAmount } = formatAmount(body.amount as string, chain);

    if (actualAmount > 0 && claimedAmount > 0) {
      const ratio = Math.abs(actualAmount - claimedAmount) / Math.max(actualAmount, claimedAmount);
      if (ratio > 0.1) {
        discrepancies.push({
          field: 'amount',
          agentClaim: `${claimedAmount} ${amountMatch[2]}`,
          actual: formatAmount(body.amount as string, chain).display,
          severity: 'critical',
        });
      }
    }
  }

  // 2. Action word mismatch (e.g., summary says "swap" but endpoint is /send)
  for (const [ep, words] of Object.entries(ACTION_WORDS)) {
    if (endpoint.startsWith(ep)) continue; // This IS the endpoint — skip
    const mentionsAction = words.some(w => summaryLower.includes(w));
    if (mentionsAction) {
      // Agent summary mentions an action that doesn't match the endpoint
      const matchedWord = words.find(w => summaryLower.includes(w))!;
      discrepancies.push({
        field: 'endpoint',
        agentClaim: matchedWord,
        actual: endpoint,
        severity: 'critical',
      });
      break; // One endpoint mismatch is enough
    }
  }

  // 3. Raw Solana transaction — amount unverifiable
  if (body.transaction) {
    discrepancies.push({
      field: 'transaction',
      agentClaim: 'amount specified in summary',
      actual: 'Raw Solana transaction — amount unverifiable from body',
      severity: 'info',
    });
  }

  // 4. Dangerous permissions
  if (permissions?.includes('wallet:export')) {
    discrepancies.push({
      field: 'permissions',
      agentClaim: 'standard permissions',
      actual: 'Includes wallet:export (can export private keys)',
      severity: 'warning',
    });
  }

  // 5. Unknown endpoint
  const knownPrefixes = ['/swap', '/send', '/fund', '/launch', '/wallet/create'];
  if (!knownPrefixes.some(p => endpoint.startsWith(p))) {
    discrepancies.push({
      field: 'endpoint',
      agentClaim: 'known action',
      actual: `Unknown endpoint: ${endpoint}`,
      severity: 'warning',
    });
  }

  return discrepancies;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

interface GenerateVerifiedSummaryInput {
  agentId: string;
  summary: string;
  permissions?: string[];
  limits?: Record<string, number>;
  walletAccess?: string[];
  ttl?: number;
  action?: ActionInput;
}

export function generateVerifiedSummary(input: GenerateVerifiedSummaryInput): VerifiedSummary {
  const { agentId, summary, permissions, walletAccess, ttl, action } = input;

  // Extract facts from the action
  const { facts, oneLiner, endpoint } = extractFacts(action);

  // Generate labels
  const permissionLabels = (permissions || []).map(formatPermissionLabel);
  // Intentionally do not mention limits in verified human-action summaries until v2.
  const limitLabels: string[] = [];

  const walletAccessLabels = (walletAccess || []).map(shortAddr);
  const ttlLabel = formatTtl(ttl);

  // Detect discrepancies
  const discrepancies = detectDiscrepancies(summary, action, permissions);
  const verified = discrepancies.filter(d => d.severity === 'critical').length === 0;

  return {
    action: endpoint,
    oneLiner,
    facts,
    permissionLabels,
    limitLabels,
    walletAccessLabels,
    ttlLabel,
    agentId,
    discrepancies,
    verified,
    generatedAt: new Date().toISOString(),
  };
}
