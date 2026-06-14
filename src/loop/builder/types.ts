import type { Result } from "neverthrow";

// Declarative loop() builder — the Effect-free authoring front door (spec loop-builder).
// Lowers to flow() + the generic fixLoop convergence primitive. No Effect type may appear
// here (design D2 facade gate). Implemented in L06/L07 (tasks 5.x, 6.x).

/** A loop variant: a measure bounded below that strictly decreases (design D3). */
export interface LoopVariant<S = unknown> {
  /** Current measure value; the loop converges as this reaches its floor. */
  measure(state: S): Promise<number>;
}

/** Preset termination archetypes that satisfy the variant without manual authoring (design D3). */
export interface TerminationPreset {
  readonly kind: PresetKind;
}

export type PresetKind =
  | "untilGatesGreen"
  | "untilManifestComplete"
  | "untilNoIssues"
  | "untilConfident"
  | "times";

/** Fan-in join policies — all four ship in v1 (design D9). */
export type JoinPolicy = "barrier" | "race" | "quorum" | "reduce";

/** Seatbelt guards layered under the variant (design D3): ceiling, wall-clock, token budget. */
export interface LoopGuards {
  readonly maxIterations?: number;
  readonly wallClockMs?: number;
  readonly tokenBudget?: number;
}

/** Discriminated stop reason; extends the fixLoop stops with `budget-exhausted`/`cancelled` (design D3). */
export type LoopStopReason =
  | "converged"
  | "unfixable"
  | "stuck"
  | "timeout"
  | "ceiling"
  | "budget-exhausted"
  | "cancelled";

/** Outcome of a completed loop run. */
export interface LoopOutcome<S = unknown> {
  readonly state: S;
  readonly stopReason: LoopStopReason;
}

/**
 * Chainable loop builder. The single-cycle case reads like a guarded `while` and needs
 * no graph/fan-out/Effect knowledge. TODO(L06, tasks 5.1-5.2): lowering to flow() + fixLoop().
 */
export interface LoopBuilder<S = unknown> {
  reason(backend: unknown, request: unknown): LoopBuilder<S>;
  step(name: string, body: (state: S) => Promise<S>): LoopBuilder<S>;
  measure(fn: LoopVariant<S>["measure"]): LoopBuilder<S>;
  until(termination: TerminationPreset | LoopVariant<S>): LoopBuilder<S>;
  guard(opts: LoopGuards): LoopBuilder<S>;
  run(): Promise<Result<LoopOutcome<S>, Error>>;
}
