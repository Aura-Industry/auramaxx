import { z } from 'zod';
import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { loadConfig } from '../config';
import { isSolanaChain, normalizeAddress } from '../address';
import type { StrategyManifest, TickTier } from './types';

export type StrategyTemplateId =
  | 'recurring_buy'
  | 'buy_on_drop'
  | 'stop_loss'
  | 'portfolio_report';

type StrategyMode = 'headless' | 'app-linked';

interface TemplateDefinition<TConfig extends Record<string, unknown>> {
  id: StrategyTemplateId;
  name: string;
  description: string;
  riskClass: 'low' | 'medium' | 'high';
  defaultMode: StrategyMode;
  defaultTicker: TickTier;
  permissionsCeiling: string[];
  limitsCeiling?: { fund?: number; send?: number };
  schema: z.ZodType<TConfig>;
  buildManifest: (input: {
    strategyId: string;
    strategyName: string;
    config: TConfig;
    mode: StrategyMode;
  }) => StrategyManifest;
  buildSchedule: (config: TConfig) => Record<string, unknown>;
}

export interface StrategyTemplateCatalogEntry {
  id: StrategyTemplateId;
  name: string;
  description: string;
  riskClass: 'low' | 'medium' | 'high';
  defaultMode: StrategyMode;
  permissionsCeiling: string[];
  limitsCeiling?: { fund?: number; send?: number };
  examplePrompts: string[];
}

export interface BuiltTemplateStrategy {
  templateId: StrategyTemplateId;
  config: Record<string, unknown>;
  manifest: StrategyManifest;
  permissions: string[];
  limits?: { fund?: number; send?: number };
  schedule: Record<string, unknown>;
}

const positiveAmount = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, 'Must be a positive number');

const percentage = z
  .union([z.string(), z.number()])
  .transform((value) => Number(value))
  .refine((value) => Number.isFinite(value) && value > 0 && value <= 95, 'Must be between 0 and 95');

function getSupportedChains(): Set<string> {
  const config = loadConfig();
  return new Set(Object.keys(config.chains));
}

function isKnownChain(chain: string): boolean {
  return getSupportedChains().has(chain);
}

function isValidChainAddress(chain: string, address: string): boolean {
  if (!isKnownChain(chain)) return false;
  if (isSolanaChain(chain)) {
    try {
      // Throws for invalid base58/public key format
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }
  return ethers.isAddress(address);
}

function normalizeTemplateAddress(chain: string, address: string): string {
  return normalizeAddress(address, chain);
}

const recurringBuySchema = z.object({
  chain: z.string().default('base'),
  wallet: z.string().min(1),
  token: z.string().min(1),
  amountUsd: positiveAmount,
  maxDailySpendUsd: positiveAmount.default('500'),
  interval: z.enum(['hourly', 'daily', 'weekly']).default('daily'),
  slippageBps: z.coerce.number().int().min(1).max(1000).default(100),
  reserveUsd: positiveAmount.default('1'),
  approve: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (!isKnownChain(value.chain)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chain'], message: `Unsupported chain "${value.chain}"` });
    return;
  }
  if (!isValidChainAddress(value.chain, value.wallet)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['wallet'], message: `Invalid wallet address for chain "${value.chain}"` });
  }
  if (!isValidChainAddress(value.chain, value.token)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['token'], message: `Invalid token address for chain "${value.chain}"` });
  }
  if (Number(value.amountUsd) > Number(value.maxDailySpendUsd)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amountUsd'],
      message: 'amountUsd cannot exceed maxDailySpendUsd',
    });
  }
}).transform((value) => ({
  ...value,
  wallet: normalizeTemplateAddress(value.chain, value.wallet),
  token: normalizeTemplateAddress(value.chain, value.token),
}));

const buyOnDropSchema = z.object({
  chain: z.string().default('base'),
  wallet: z.string().min(1),
  token: z.string().min(1),
  dropPercent: percentage,
  amountUsd: positiveAmount,
  lookbackWindow: z.enum(['1h', '4h', '24h']).default('24h'),
  cooldownMinutes: z.coerce.number().int().min(1).max(1440).default(120),
  expireAfterHours: z.coerce.number().int().min(1).max(720).default(72),
  maxExecutions: z.coerce.number().int().min(1).max(50).default(1),
  slippageBps: z.coerce.number().int().min(1).max(1000).default(150),
  approve: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (!isKnownChain(value.chain)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chain'], message: `Unsupported chain "${value.chain}"` });
    return;
  }
  if (!isValidChainAddress(value.chain, value.wallet)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['wallet'], message: `Invalid wallet address for chain "${value.chain}"` });
  }
  if (!isValidChainAddress(value.chain, value.token)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['token'], message: `Invalid token address for chain "${value.chain}"` });
  }
}).transform((value) => ({
  ...value,
  wallet: normalizeTemplateAddress(value.chain, value.wallet),
  token: normalizeTemplateAddress(value.chain, value.token),
}));

const stopLossSchema = z.object({
  chain: z.string().default('base'),
  wallet: z.string().min(1),
  token: z.string().min(1),
  dropPercent: percentage,
  sellPercent: z.coerce.number().int().min(1).max(100).default(100),
  cooldownMinutes: z.coerce.number().int().min(1).max(1440).default(60),
  expireAfterHours: z.coerce.number().int().min(1).max(720).default(72),
  maxExecutions: z.coerce.number().int().min(1).max(50).default(1),
  slippageBps: z.coerce.number().int().min(1).max(1000).default(200),
  approve: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (!isKnownChain(value.chain)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chain'], message: `Unsupported chain "${value.chain}"` });
    return;
  }
  if (!isValidChainAddress(value.chain, value.wallet)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['wallet'], message: `Invalid wallet address for chain "${value.chain}"` });
  }
  if (!isValidChainAddress(value.chain, value.token)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['token'], message: `Invalid token address for chain "${value.chain}"` });
  }
}).transform((value) => ({
  ...value,
  wallet: normalizeTemplateAddress(value.chain, value.wallet),
  token: normalizeTemplateAddress(value.chain, value.token),
}));

const watchTargetSchema = z.object({
  chain: z.string().default('base'),
  address: z.string().min(1),
  label: z.string().max(80).optional(),
}).superRefine((value, ctx) => {
  if (!isKnownChain(value.chain)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chain'], message: `Unsupported chain "${value.chain}"` });
    return;
  }
  if (!isValidChainAddress(value.chain, value.address)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['address'],
      message: `Invalid watch address for chain "${value.chain}"`,
    });
  }
}).transform((value) => ({
  ...value,
  address: normalizeTemplateAddress(value.chain, value.address),
}));

const portfolioReportSchema = z.object({
  watch: z.preprocess((raw) => {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') return [raw];
    return raw;
  }, z.array(watchTargetSchema).min(1, 'At least one watch target is required')),
  interval: z.enum(['hourly', 'daily']).default('hourly'),
  includeNative: z.boolean().default(true),
  includeTokens: z.boolean().default(true),
  minChangeUsd: z.coerce.number().min(0).default(0),
  dedupeWindowMinutes: z.coerce.number().int().min(1).max(1440).default(60),
  stalenessMinutes: z.coerce.number().int().min(1).max(1440).default(30),
  notifyRateLimitPerHour: z.coerce.number().int().min(1).max(120).default(6),
  notifyAdapter: z.string().default('dashboard'),
});

function commonManifest(input: {
  strategyId: string;
  strategyName: string;
  ticker: TickTier;
  config: Record<string, unknown>;
  permissions: string[];
  limits?: { fund?: number; send?: number };
  tickPrompt: string;
  executePrompt?: string;
  resultPrompt?: string;
}): StrategyManifest {
  return {
    id: input.strategyId,
    name: input.strategyName,
    ticker: input.ticker,
    sources: [],
    hooks: {
      tick: input.tickPrompt,
      execute: input.executePrompt,
      result: input.resultPrompt,
    },
    config: input.config,
    permissions: input.permissions,
    limits: input.limits,
    allowedHosts: [],
  };
}

const templateDefinitions: Record<StrategyTemplateId, TemplateDefinition<Record<string, unknown>>> = {
  recurring_buy: {
    id: 'recurring_buy',
    name: 'Recurring Buy',
    description: 'Buy a token on a recurring schedule with spend guardrails.',
    riskClass: 'medium',
    defaultMode: 'headless',
    defaultTicker: 'maintenance',
    permissionsCeiling: ['wallet:list', 'swap'],
    limitsCeiling: { fund: 0, send: 0 },
    schema: recurringBuySchema as z.ZodType<Record<string, unknown>>,
    buildManifest: ({ strategyId, strategyName, config }) =>
      commonManifest({
        strategyId,
        strategyName,
        ticker: 'maintenance',
        config,
        permissions: ['wallet:list', 'swap'],
        tickPrompt: 'Evaluate recurring buy schedule and emit swap intent only when due and within configured spend/risk limits.',
        executePrompt: 'Convert approved recurring_buy intent into a single /swap API action with explicit slippage constraints.',
        resultPrompt: 'Record last execution timestamp, spend totals, and execution result summary.',
      }),
    buildSchedule: (config) => ({
      kind: 'interval',
      interval: typeof config.interval === 'string' ? config.interval : 'daily',
    }),
  },
  buy_on_drop: {
    id: 'buy_on_drop',
    name: 'Buy On Drop',
    description: 'Trigger a bounded buy when a token drops by a configured threshold.',
    riskClass: 'medium',
    defaultMode: 'headless',
    defaultTicker: 'active',
    permissionsCeiling: ['wallet:list', 'swap'],
    limitsCeiling: { fund: 0, send: 0 },
    schema: buyOnDropSchema as z.ZodType<Record<string, unknown>>,
    buildManifest: ({ strategyId, strategyName, config }) =>
      commonManifest({
        strategyId,
        strategyName,
        ticker: 'active',
        config,
        permissions: ['wallet:list', 'swap'],
        tickPrompt: 'Evaluate price movement and emit one buy intent only when drop threshold is crossed and cooldown/expiry rules pass.',
        executePrompt: 'Convert approved buy_on_drop intent into a single /swap API action with bounded amount and slippage.',
        resultPrompt: 'Update trigger history, cooldown markers, and execution outcome fields.',
      }),
    buildSchedule: (config) => ({
      kind: 'trigger',
      source: 'price_drop',
      lookbackWindow: typeof config.lookbackWindow === 'string' ? config.lookbackWindow : '24h',
    }),
  },
  stop_loss: {
    id: 'stop_loss',
    name: 'Stop Loss',
    description: 'Trigger a bounded sell when a token drops below the configured threshold.',
    riskClass: 'medium',
    defaultMode: 'headless',
    defaultTicker: 'active',
    permissionsCeiling: ['wallet:list', 'swap'],
    limitsCeiling: { fund: 0, send: 0 },
    schema: stopLossSchema as z.ZodType<Record<string, unknown>>,
    buildManifest: ({ strategyId, strategyName, config }) =>
      commonManifest({
        strategyId,
        strategyName,
        ticker: 'active',
        config,
        permissions: ['wallet:list', 'swap'],
        tickPrompt: 'Evaluate downside trigger conditions and emit one stop-loss sell intent when threshold and cooldown allow.',
        executePrompt: 'Convert approved stop_loss intent into a /swap API action for exiting configured position size.',
        resultPrompt: 'Persist trigger execution state, cooldown timestamps, and latest outcome.',
      }),
    buildSchedule: () => ({ kind: 'trigger', source: 'price_drop' }),
  },
  portfolio_report: {
    id: 'portfolio_report',
    name: 'Portfolio Report',
    description: 'Watch any valid address and report balance changes on schedule.',
    riskClass: 'low',
    defaultMode: 'headless',
    defaultTicker: 'slow',
    permissionsCeiling: ['wallet:list'],
    schema: portfolioReportSchema as z.ZodType<Record<string, unknown>>,
    buildManifest: ({ strategyId, strategyName, config }) => {
      const interval = typeof config.interval === 'string' ? config.interval : 'hourly';
      return commonManifest({
        strategyId,
        strategyName,
        ticker: interval === 'daily' ? 'maintenance' : 'slow',
        config,
        permissions: ['wallet:list'],
        tickPrompt: 'Collect current balance snapshots for configured watch addresses and emit notify intent only when change threshold is exceeded.',
        executePrompt: 'Convert notify intent into an internal event/notification action without trade or transfer side effects.',
        resultPrompt: 'Store latest snapshots, dedupe keys, and report metadata.',
      });
    },
    buildSchedule: (config) => ({
      kind: 'interval',
      interval: typeof config.interval === 'string' ? config.interval : 'hourly',
    }),
  },
};

const templatePrompts: Record<StrategyTemplateId, string[]> = {
  recurring_buy: ['Buy $100 of BNKR every day'],
  buy_on_drop: ['Buy 50 BNKR if it dips 15%'],
  stop_loss: ['Place stop loss for $100 BNKR at 10% drop'],
  portfolio_report: ['Report balance changes for this address every hour'],
};

export function listStrategyTemplates(): StrategyTemplateCatalogEntry[] {
  return (Object.values(templateDefinitions) as TemplateDefinition<Record<string, unknown>>[]).map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    riskClass: template.riskClass,
    defaultMode: template.defaultMode,
    permissionsCeiling: template.permissionsCeiling,
    limitsCeiling: template.limitsCeiling,
    examplePrompts: templatePrompts[template.id],
  }));
}

export function isSupportedTemplate(templateId: string): templateId is StrategyTemplateId {
  return templateId in templateDefinitions;
}

export function buildTemplateStrategy(input: {
  templateId: StrategyTemplateId;
  strategyId: string;
  strategyName: string;
  mode: StrategyMode;
  rawConfig: unknown;
}): BuiltTemplateStrategy {
  const definition = templateDefinitions[input.templateId];
  const parsedConfig = definition.schema.parse(input.rawConfig ?? {});
  const manifest = definition.buildManifest({
    strategyId: input.strategyId,
    strategyName: input.strategyName,
    config: parsedConfig,
    mode: input.mode,
  });
  const schedule = definition.buildSchedule(parsedConfig);

  return {
    templateId: input.templateId,
    config: parsedConfig,
    manifest,
    permissions: definition.permissionsCeiling,
    limits: definition.limitsCeiling,
    schedule,
  };
}
