import { z } from 'zod';

export const E2E_AGENT_ERROR_CODES = {
  schemaAssertion: 'E_SCHEMA_ASSERTION',
  egressPolicy: 'E_EGRESS_POLICY',
  clockDrift: 'E_CLOCK_DRIFT',
  budgetDuration: 'E_BUDGET_DURATION',
  budgetSteps: 'E_BUDGET_STEPS',
  budgetToolCalls: 'E_BUDGET_TOOL_CALLS',
  budgetTokens: 'E_BUDGET_TOKENS',
} as const;

const assertionBaseSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['ui', 'api', 'db']),
  op: z.enum(['equals', 'contains', 'exists', 'not_exists', 'gt', 'gte', 'lt', 'lte']),
});

const uiAssertionSchema = assertionBaseSchema.extend({
  type: z.literal('ui'),
  selector: z.string().min(1),
  expected: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const apiAssertionSchema = assertionBaseSchema.extend({
  type: z.literal('api'),
  endpoint: z.string().min(1),
  path: z.string().min(1),
  expected: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const dbAssertionSchema = assertionBaseSchema.extend({
  type: z.literal('db'),
  query: z.string().min(1),
  expected: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const assertionSchema = z.discriminatedUnion('type', [
  uiAssertionSchema,
  apiAssertionSchema,
  dbAssertionSchema,
]);

export const budgetSchema = z.object({
  maxDurationSec: z.number().int().positive(),
  maxSteps: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
});

export const scenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  mode: z.enum(['agent-hybrid', 'scripted']),
  clock: z.object({
    baseTimeIso: z.string().datetime(),
  }),
  budget: budgetSchema.partial().optional(),
  assertions: z.array(assertionSchema).min(1),
});

export type Assertion = z.infer<typeof assertionSchema>;
export type Budget = z.infer<typeof budgetSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;

export type Lane = 'pr-smoke' | 'nightly';

export interface LaneBudgetCaps {
  maxDurationSec: number;
  maxSteps: number;
  maxToolCalls: number;
  maxTokens: number;
}

export const REPO_DEFAULT_BUDGET: Budget = {
  maxDurationSec: 90,
  maxSteps: 15,
  maxToolCalls: 12,
  maxTokens: 12000,
};

export const LANE_BUDGET_CAPS: Record<Lane, LaneBudgetCaps> = {
  'pr-smoke': {
    maxDurationSec: 120,
    maxSteps: 20,
    maxToolCalls: 16,
    maxTokens: 16000,
  },
  nightly: {
    maxDurationSec: 240,
    maxSteps: 40,
    maxToolCalls: 30,
    maxTokens: 40000,
  },
};

export interface ClockProbe {
  runnerMs: number;
  serverMs: number;
  browserMs: number;
  fixtureMs: number;
}

export interface RunFingerprint {
  scenarioId: string;
  lane: Lane;
  mode: Scenario['mode'];
  clockBaseTimeIso: string;
  schemaVersion: string;
  runnerVersion: string;
  gitCommit: string;
}
