import { parse as parseYaml } from 'yaml';
import {
  Budget,
  ClockProbe,
  E2E_AGENT_ERROR_CODES,
  LANE_BUDGET_CAPS,
  Lane,
  REPO_DEFAULT_BUDGET,
  Scenario,
  scenarioSchema,
} from './contracts';

export class E2EAgentValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'E2EAgentValidationError';
  }
}

export function parseScenarioDocument(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return parseYaml(input);
  }
}

export function validateScenario(raw: unknown): Scenario {
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new E2EAgentValidationError(
      E2E_AGENT_ERROR_CODES.schemaAssertion,
      parsed.error.issues.map((issue) => issue.message).join('; ')
    );
  }

  return parsed.data;
}

export function applyBudgetPolicy(scenarioBudget: Partial<Budget> | undefined, lane: Lane): Budget {
  const merged: Budget = {
    ...REPO_DEFAULT_BUDGET,
    ...(scenarioBudget ?? {}),
  };

  const laneCaps = LANE_BUDGET_CAPS[lane];

  if (merged.maxDurationSec > laneCaps.maxDurationSec) {
    throw new E2EAgentValidationError(
      E2E_AGENT_ERROR_CODES.budgetDuration,
      `maxDurationSec (${merged.maxDurationSec}) exceeds lane cap (${laneCaps.maxDurationSec})`
    );
  }

  if (merged.maxSteps > laneCaps.maxSteps) {
    throw new E2EAgentValidationError(
      E2E_AGENT_ERROR_CODES.budgetSteps,
      `maxSteps (${merged.maxSteps}) exceeds lane cap (${laneCaps.maxSteps})`
    );
  }

  if (merged.maxToolCalls > laneCaps.maxToolCalls) {
    throw new E2EAgentValidationError(
      E2E_AGENT_ERROR_CODES.budgetToolCalls,
      `maxToolCalls (${merged.maxToolCalls}) exceeds lane cap (${laneCaps.maxToolCalls})`
    );
  }

  if (merged.maxTokens > laneCaps.maxTokens) {
    throw new E2EAgentValidationError(
      E2E_AGENT_ERROR_CODES.budgetTokens,
      `maxTokens (${merged.maxTokens}) exceeds lane cap (${laneCaps.maxTokens})`
    );
  }

  return merged;
}

export function enforceClockDrift(probe: ClockProbe): void {
  const values = [probe.runnerMs, probe.serverMs, probe.browserMs, probe.fixtureMs];
  const drift = Math.max(...values) - Math.min(...values);

  if (drift > 50) {
    throw new E2EAgentValidationError(
      E2E_AGENT_ERROR_CODES.clockDrift,
      `Clock drift ${drift}ms exceeded tolerance`
    );
  }
}

export function enforceEgressPolicy(hostname: string, allowedHosts: readonly string[]): void {
  if (!allowedHosts.includes(hostname)) {
    throw new E2EAgentValidationError(
      E2E_AGENT_ERROR_CODES.egressPolicy,
      `Blocked outbound host: ${hostname}`
    );
  }
}

export interface RuntimeUsage {
  durationSec: number;
  steps: number;
  toolCalls: number;
  tokens: number;
}

export function enforceRuntimeBudget(usage: RuntimeUsage, budget: Budget): void {
  if (usage.durationSec > budget.maxDurationSec) {
    throw new E2EAgentValidationError(
      E2E_AGENT_ERROR_CODES.budgetDuration,
      `durationSec ${usage.durationSec} exceeded ${budget.maxDurationSec}`
    );
  }

  if (usage.steps > budget.maxSteps) {
    throw new E2EAgentValidationError(
      E2E_AGENT_ERROR_CODES.budgetSteps,
      `steps ${usage.steps} exceeded ${budget.maxSteps}`
    );
  }

  if (usage.toolCalls > budget.maxToolCalls) {
    throw new E2EAgentValidationError(
      E2E_AGENT_ERROR_CODES.budgetToolCalls,
      `toolCalls ${usage.toolCalls} exceeded ${budget.maxToolCalls}`
    );
  }

  if (usage.tokens > budget.maxTokens) {
    throw new E2EAgentValidationError(
      E2E_AGENT_ERROR_CODES.budgetTokens,
      `tokens ${usage.tokens} exceeded ${budget.maxTokens}`
    );
  }
}
