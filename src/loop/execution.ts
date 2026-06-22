import { err, ok, type Result } from "neverthrow";

import type { BranchObservation } from "../monitor/index.ts";
import type { RuntimeError, Usage } from "../model/index.ts";
import {
  compact,
  createOffloadStore,
  DEFAULT_COMPACTION_CONFIG,
  type CompactionConfig,
  type CompactionStage,
  type Observation,
  type OffloadStore,
} from "./context/index.ts";
import {
  makeFingerprintStuckDetector,
  TokenBudgetCounter,
  type FingerprintAction,
  type FingerprintDetectorOptions,
  type TokenUsageSummary,
} from "./termination.ts";

export type LoopExecutionStop =
  | "converged"
  | "unfixable"
  | "stuck"
  | "timeout"
  | "ceiling"
  | "budget-exhausted"
  | "cancelled";

export type LoopExecutionAction = FingerprintAction;

export interface LoopContextPressure {
  readonly offloadCount: number;
  readonly compactionStages: readonly CompactionStage[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly observationCount: number;
}

export interface LoopExecutionStepResult {
  readonly usage?: Usage;
  readonly observations?: readonly Observation[];
  readonly branches?: readonly BranchObservation[];
  readonly measure?: number;
  readonly stopReason?: LoopExecutionStop;
  readonly contextPressure?: LoopContextPressure;
}

export interface LoopExecutionProgress {
  readonly iteration: number;
  readonly usage?: Usage;
  readonly branches?: readonly BranchObservation[];
  readonly measure?: number;
  readonly stopReason?: LoopExecutionStop;
  readonly contextPressure?: LoopContextPressure;
}

export interface LoopExecutionContextOptions {
  readonly root?: string;
  readonly config?: CompactionConfig;
  readonly offloadStore?: OffloadStore;
  readonly observations?: readonly Observation[];
}

export interface LoopExecutionContextSnapshot {
  readonly observations: readonly Observation[];
  readonly lastPressure?: LoopContextPressure;
}

export interface LoopExecutionSummary<State> {
  readonly iterations: number;
  readonly converged: boolean;
  readonly stop: LoopExecutionStop;
  readonly lastEvaluation: State;
  readonly events: readonly string[];
  readonly tokenUsage?: TokenUsageSummary;
  readonly context: LoopExecutionContextSnapshot;
}

export interface LoopExecutionOptions<State, Action extends LoopExecutionAction = LoopExecutionAction> {
  readonly evaluate: () => Promise<Result<State, RuntimeError>>;
  readonly converged: (state: State) => boolean;
  readonly nextAction: (state: State) => Action | undefined;
  readonly execute: (action: Action, state: State, iteration: number) => Promise<Result<unknown, RuntimeError>>;
  readonly maxIterations?: number;
  readonly wallClockMs?: number;
  readonly tokenBudget?: number;
  readonly stalled?: (state: State, action: Action) => boolean;
  readonly fingerprint?:
    | false
    | Omit<FingerprintDetectorOptions<{ readonly state: State; readonly action: Action }>, "project">;
  readonly now?: () => number;
  readonly context?: LoopExecutionContextOptions;
  readonly onCycle?: (progress: LoopExecutionProgress) => void;
}

export async function executeLoop<State, Action extends LoopExecutionAction = LoopExecutionAction>(
  options: LoopExecutionOptions<State, Action>,
): Promise<Result<LoopExecutionSummary<State>, RuntimeError>> {
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const events: string[] = [];
  const budget = new TokenBudgetCounter(options.tokenBudget);
  const fingerprintStalled = executionFingerprintDetector(options.fingerprint);
  const managedContext = createManagedContext(options.context);
  let iterations = 0;

  for (;;) {
    const evalResult = await evaluateState(options.evaluate, events);
    if (evalResult.isErr()) return err(evalResult.error);

    const state = evalResult.value;
    if (options.converged(state)) {
      return ok(executionSummary(state, iterations, "converged", events, budget, managedContext.snapshot()));
    }

    const action = options.nextAction(state);
    if (action === undefined) {
      return ok(executionSummary(state, iterations, "unfixable", events, budget, managedContext.snapshot()));
    }

    if (options.stalled?.(state, action) || fingerprintStalled?.({ state, action })) {
      events.push("no-progress");
      return ok(executionSummary(state, iterations, "stuck", events, budget, managedContext.snapshot()));
    }

    if (iterations >= maxIterations) {
      return ok(executionSummary(state, iterations, "ceiling", events, budget, managedContext.snapshot()));
    }

    if (options.wallClockMs !== undefined && now() - startedAt >= options.wallClockMs) {
      return ok(executionSummary(state, iterations, "timeout", events, budget, managedContext.snapshot()));
    }

    events.push("fix:started");
    const stepResult = await options.execute(action, state, iterations);
    if (stepResult.isErr()) return err(stepResult.error);
    events.push("fix:completed");
    iterations++;

    const step = normalizeStepResult(stepResult.value);
    budget.record(step.usage);

    const pressure = await managedContext.record(step.observations);
    if (pressure.isErr()) return err(pressure.error);

    const contextPressure = mergePressure(step.contextPressure, pressure.value);
    options.onCycle?.({
      iteration: iterations,
      ...(step.usage === undefined ? {} : { usage: step.usage }),
      ...(step.branches === undefined ? {} : { branches: step.branches }),
      ...(step.measure === undefined ? {} : { measure: step.measure }),
      ...(step.stopReason === undefined ? {} : { stopReason: step.stopReason }),
      ...(contextPressure === undefined ? {} : { contextPressure }),
    });

    if (step.stopReason !== undefined) {
      const refreshed = await evaluateState(options.evaluate, events);
      if (refreshed.isErr()) return err(refreshed.error);
      return ok(
        executionSummary(refreshed.value, iterations, step.stopReason, events, budget, managedContext.snapshot()),
      );
    }

    if (budget.exhausted) {
      const refreshed = await evaluateState(options.evaluate, events);
      if (refreshed.isErr()) return err(refreshed.error);
      events.push("budget:exhausted");
      return ok(
        executionSummary(refreshed.value, iterations, "budget-exhausted", events, budget, managedContext.snapshot()),
      );
    }
  }
}

async function evaluateState<State>(
  evaluate: () => Promise<Result<State, RuntimeError>>,
  events: string[],
): Promise<Result<State, RuntimeError>> {
  events.push("evaluate:started");
  const evalResult = await evaluate();
  if (evalResult.isErr()) return err(evalResult.error);
  events.push("evaluate:completed");
  return evalResult;
}

function executionSummary<State>(
  state: State,
  iterations: number,
  stop: LoopExecutionStop,
  events: readonly string[],
  budget: TokenBudgetCounter,
  context: LoopExecutionContextSnapshot,
): LoopExecutionSummary<State> {
  return {
    iterations,
    converged: stop === "converged",
    stop,
    lastEvaluation: state,
    events,
    ...(budget.shouldReport ? { tokenUsage: budget.summary() } : {}),
    context,
  };
}

function executionFingerprintDetector<State, Action extends LoopExecutionAction>(
  fingerprint: LoopExecutionOptions<State, Action>["fingerprint"],
): ((value: { readonly state: State; readonly action: Action }) => boolean) | undefined {
  if (fingerprint === undefined || fingerprint === false) {
    return undefined;
  }

  return makeFingerprintStuckDetector({
    project: ({ action }) => action,
    ...(fingerprint.windowSize === undefined ? {} : { windowSize: fingerprint.windowSize }),
    ...(fingerprint.repeatThreshold === undefined ? {} : { repeatThreshold: fingerprint.repeatThreshold }),
  });
}

function normalizeStepResult(value: unknown): LoopExecutionStepResult {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const usage = usageFromStepResult(record);
  const observations = observationsFrom(record.observations);
  const branches = branchesFrom(record.branches);
  const measure = typeof record.measure === "number" ? record.measure : undefined;
  const stopReason = stopReasonFrom(record.stopReason);
  const contextPressure = contextPressureFrom(record.contextPressure);

  return {
    ...(usage === undefined ? {} : { usage }),
    ...(observations === undefined ? {} : { observations }),
    ...(branches === undefined ? {} : { branches }),
    ...(measure === undefined ? {} : { measure }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(contextPressure === undefined ? {} : { contextPressure }),
  };
}

function usageFromStepResult(record: Record<string, unknown>): Usage | undefined {
  const usage = record.usage;
  if (typeof usage !== "object" || usage === null || !("input" in usage) || !("output" in usage)) {
    return undefined;
  }

  const input = usage.input;
  const output = usage.output;
  const reasoning = "reasoning" in usage ? usage.reasoning : undefined;
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    !Number.isInteger(input) ||
    !Number.isInteger(output) ||
    (reasoning !== undefined && (typeof reasoning !== "number" || !Number.isInteger(reasoning)))
  ) {
    return undefined;
  }

  return reasoning === undefined ? { input, output } : { input, output, reasoning };
}

function observationsFrom(value: unknown): readonly Observation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const observations: Observation[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.content !== "string") {
      return undefined;
    }
    observations.push({
      id: record.id,
      content: record.content,
      ...(record.pinned === true ? { pinned: true } : {}),
      ...(typeof record.tokens === "number" ? { tokens: record.tokens } : {}),
    });
  }
  return observations;
}

function branchesFrom(value: unknown): readonly BranchObservation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const branches: BranchObservation[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      (record.status !== "completed" && record.status !== "failed")
    ) {
      return undefined;
    }
    const usage = usageFromStepResult(record);
    branches.push({
      id: record.id,
      status: record.status,
      ...(usage === undefined ? {} : { usage }),
    });
  }
  return branches;
}

function stopReasonFrom(value: unknown): LoopExecutionStop | undefined {
  switch (value) {
    case "converged":
    case "unfixable":
    case "stuck":
    case "timeout":
    case "ceiling":
    case "budget-exhausted":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

function contextPressureFrom(value: unknown): LoopContextPressure | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.offloadCount !== "number" ||
    !Array.isArray(record.compactionStages) ||
    typeof record.tokensBefore !== "number" ||
    typeof record.tokensAfter !== "number" ||
    typeof record.observationCount !== "number"
  ) {
    return undefined;
  }
  const stages = record.compactionStages.filter(isCompactionStage);
  if (stages.length !== record.compactionStages.length) {
    return undefined;
  }
  return {
    offloadCount: record.offloadCount,
    compactionStages: stages,
    tokensBefore: record.tokensBefore,
    tokensAfter: record.tokensAfter,
    observationCount: record.observationCount,
  };
}

function isCompactionStage(value: unknown): value is CompactionStage {
  return value === "mask" || value === "prune" || value === "summarize";
}

function createManagedContext(options: LoopExecutionContextOptions | undefined): {
  record: (observations: readonly Observation[] | undefined) => Promise<Result<LoopContextPressure | undefined, RuntimeError>>;
  snapshot: () => LoopExecutionContextSnapshot;
} {
  if (options === undefined) {
    return {
      record: () => Promise.resolve(ok(undefined)),
      snapshot: () => ({ observations: [] }),
    };
  }

  const config = options.config ?? DEFAULT_COMPACTION_CONFIG;
  const offloadStore =
    options.offloadStore ??
    createOffloadStore({
      root: options.root ?? process.cwd(),
      thresholdChars: config.offloadThresholdChars,
    });
  let observations = [...(options.observations ?? [])];
  let lastPressure: LoopContextPressure | undefined;

  return {
    async record(nextObservations) {
      let offloadCount = 0;
      if (nextObservations !== undefined) {
        const bounded: Observation[] = [];
        for (const observation of nextObservations) {
          const intercepted = await offloadStore.intercept(observation.content);
          if (intercepted.isErr()) {
            return err(intercepted.error);
          }
          if (intercepted.value.offloaded) {
            offloadCount++;
            bounded.push({
              id: observation.id,
              content: intercepted.value.ref,
              ...(observation.pinned === undefined ? {} : { pinned: observation.pinned }),
            });
          } else {
            bounded.push(observation);
          }
        }
        observations = [...observations, ...bounded];
      }

      if (observations.length === 0) {
        return ok(undefined);
      }

      const compacted = compact(observations, config);
      observations = [...compacted.observations];
      if (offloadCount === 0 && compacted.stagesApplied.length === 0) {
        return ok(undefined);
      }
      const pressure = {
        offloadCount,
        compactionStages: compacted.stagesApplied,
        tokensBefore: compacted.tokensBefore,
        tokensAfter: compacted.tokensAfter,
        observationCount: observations.length,
      };
      lastPressure = pressure;
      return ok(pressure);
    },

    snapshot() {
      return {
        observations: [...observations],
        ...(lastPressure === undefined ? {} : { lastPressure }),
      };
    },
  };
}

function mergePressure(
  explicit: LoopContextPressure | undefined,
  managed: LoopContextPressure | undefined,
): LoopContextPressure | undefined {
  if (explicit === undefined) {
    return managed;
  }
  if (managed === undefined) {
    return explicit;
  }
  return {
    offloadCount: explicit.offloadCount + managed.offloadCount,
    compactionStages: [...explicit.compactionStages, ...managed.compactionStages],
    tokensBefore: Math.max(explicit.tokensBefore, managed.tokensBefore),
    tokensAfter: managed.tokensAfter,
    observationCount: managed.observationCount,
  };
}
