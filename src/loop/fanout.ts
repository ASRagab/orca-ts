import { err, ok, type Result } from "neverthrow";

import type { JoinPolicy } from "./builder/types.ts";
import { runBoundedBranches } from "./engine/index.ts";
import type { RuntimeError, Usage } from "../model/index.ts";
import type { BranchWritableStateStore, StateHash, StateReducer, StateStore } from "./state/index.ts";

// Opt-in fan-out / fan-in combinators (spec loop-builder "Bounded fan-out and join-policy fan-in
// are opt-in combinators"; design D9; tasks 6.1–6.4). Effect-FREE by mandate (design D2 facade
// gate): all concurrency goes through the engine's plain `runBoundedBranches` seam, so no Effect
// type appears here or in the generated loop declaration. Importing nothing of these leaves the
// single-cycle loop() authoring surface from L06 unchanged.
//
// One machinery, four policies (design D9): `fanOut` COLLECTS branch results under a concurrency
// cap with an isolated state copy per branch; `fanIn` APPLIES a join policy to choose which
// successes count, then a reducer — the ONLY place branch state recombines (design D4
// StateStore.merge; never shared-mutable) — under a partial-failure policy.

/** Default per-branch summary budget: ~1.5k tokens at ~4 chars/token (task 6.3). */
const DEFAULT_SUMMARY_BUDGET_CHARS = 6000;

/**
 * What an isolated branch returns: a bounded prose summary (NEVER the raw branch state, task 6.3)
 * plus an optional small structured payload the reducer folds. `fanOut` truncates `summary` to the
 * configured char budget so one runaway branch cannot blow the parent loop's context window.
 */
export interface BranchSummary<D = unknown> {
  readonly summary: string;
  readonly data?: D;
}

/** A branch: pure work over an ISOLATED copy of the input state, returning a condensed summary. */
export type Branch<S, D> = (isolated: S) => Promise<BranchSummary<D>> | BranchSummary<D>;

/** A branch that threw/rejected; the message is preserved for the partial-failure report. */
export interface BranchFailure {
  readonly message: string;
}

/**
 * Per-branch outcome captured by `fanOut`. Failure is DATA, not a thrown error, so `fanIn`'s
 * partial-failure policy can weigh it; `elapsedMs` lets the `race` policy pick the fastest success.
 */
export type BranchOutcome<D = unknown> =
  | { readonly index: number; readonly ok: true; readonly summary: BranchSummary<D>; readonly elapsedMs: number }
  | { readonly index: number; readonly ok: false; readonly error: BranchFailure; readonly elapsedMs: number };

type SuccessOutcome<D> = Extract<BranchOutcome<D>, { ok: true }>;
type SelectableSuccess<D> = { readonly ok: true; readonly summary: BranchSummary<D>; readonly elapsedMs: number };

export interface FanOutSpec<S, D> {
  /** Shared input state; each branch receives an isolated `structuredClone`, never the original. */
  readonly state: S;
  readonly branches: readonly Branch<S, D>[];
  /** Concurrency cap (design D2/D8: in-process, ~3–10): at most this many branches run at once. */
  readonly maxConcurrency: number;
  /** Per-branch summary char budget; defaults to ~1.5k tokens. */
  readonly summaryBudgetChars?: number;
  /** Aborting interrupts in-flight branches and fails the fan-out with `cancelled`. */
  readonly signal?: AbortSignal;
}

/**
 * `fanOut` fails as a whole only on misconfiguration or hard interruption — never on a branch
 * failure, which is captured per-branch for `fanIn`'s partial-failure policy to decide.
 */
export type FanOutError =
  | { readonly kind: "misconfigured"; readonly reason: string }
  | { readonly kind: "cancelled"; readonly reason: string };

/** The merge reducer — the ONLY point where branch results recombine into one state. */
export type FanInReducer<S, D> = (summaries: readonly BranchSummary<D>[]) => S;

/** What to do when some branches failed. */
export type PartialFailurePolicy =
  | { readonly kind: "fail-fast" } // any branch failure fails the fan-in
  | { readonly kind: "tolerate"; readonly minSuccess: number }; // proceed if at least this many succeeded

export interface FanInOptions<S, D> {
  readonly reducer: FanInReducer<S, D>;
  /** Defaults per policy: `barrier` ⇒ fail-fast; `quorum` ⇒ tolerate(quorum); `race`/`reduce` ⇒ tolerate(1). */
  readonly onPartialFailure?: PartialFailurePolicy;
  /** Required for `quorum`: proceed once this many branches AGREE. */
  readonly quorum?: number;
  /** Agreement key for `quorum`; defaults to the branch's `data`, falling back to its `summary`. */
  readonly agreeBy?: (summary: BranchSummary<D>) => unknown;
}

export type FanInError =
  | {
      readonly kind: "partial-failure";
      readonly succeeded: number;
      readonly failed: number;
      readonly failures: readonly BranchFailure[];
    }
  | { readonly kind: "no-success"; readonly failures: readonly BranchFailure[] }
  | { readonly kind: "no-quorum"; readonly required: number; readonly largestAgreement: number }
  | { readonly kind: "misconfigured"; readonly reason: string };

export interface StoreBackedBranchContext {
  readonly index: number;
  readonly branchHash: StateHash;
}

export interface StoreBackedBranchResult<S, D = unknown> {
  readonly state: S;
  readonly summary?: BranchSummary<D>;
  readonly usage?: Usage;
}

export type StoreBackedBranch<S, D = unknown> = (
  state: S,
  context: StoreBackedBranchContext,
) => Promise<StoreBackedBranchResult<S, D>> | StoreBackedBranchResult<S, D>;

export interface StoreBackedFanOutSpec<S, D = unknown> {
  readonly store: BranchWritableStateStore<S>;
  readonly from: StateHash;
  readonly branches: readonly StoreBackedBranch<S, D>[];
  readonly maxConcurrency: number;
  readonly summaryBudgetChars?: number;
  readonly signal?: AbortSignal;
}

export type StoreBackedBranchOutcome<D = unknown> =
  | {
      readonly index: number;
      readonly ok: true;
      readonly branchHash: StateHash;
      readonly stateHash: StateHash;
      readonly summary: BranchSummary<D>;
      readonly elapsedMs: number;
      readonly usage?: Usage;
    }
  | {
      readonly index: number;
      readonly ok: false;
      readonly branchHash?: StateHash;
      readonly error: BranchFailure;
      readonly elapsedMs: number;
      readonly usage?: Usage;
    };

export interface StoreBackedFanInOptions<S, D = unknown> {
  readonly store: StateStore<S>;
  readonly reducer: StateReducer<S>;
  readonly onPartialFailure?: PartialFailurePolicy;
  readonly quorum?: number;
  readonly agreeBy?: (summary: BranchSummary<D>) => unknown;
}

/**
 * Bounded fan-out (tasks 6.1, 6.3). Runs each branch over an isolated `structuredClone` of `state`
 * (copy-on-fanout: no shared-mutable across branches) with at most `maxConcurrency` running at
 * once, and returns every branch's outcome — successes carry a condensed summary, failures carry a
 * message — for `fanIn` to combine. The whole fan-out errs only on misconfiguration or abort.
 */
export async function fanOut<S, D = unknown>(
  spec: FanOutSpec<S, D>,
): Promise<Result<readonly BranchOutcome<D>[], FanOutError>> {
  if (spec.branches.length === 0) {
    return err({ kind: "misconfigured", reason: "fanOut requires at least one branch" });
  }
  if (!Number.isFinite(spec.maxConcurrency) || spec.maxConcurrency < 1) {
    return err({
      kind: "misconfigured",
      reason: `fanOut maxConcurrency must be a finite integer >= 1 (got ${String(spec.maxConcurrency)})`,
    });
  }
  const budget = spec.summaryBudgetChars ?? DEFAULT_SUMMARY_BUDGET_CHARS;

  const thunks = spec.branches.map((branch, index) => async (): Promise<BranchOutcome<D>> => {
    const isolated = structuredClone(spec.state); // copy-on-fanout — a branch sees only its own copy
    const start = Date.now();
    try {
      const summary = condense(await branch(isolated), budget);
      return { index, ok: true, summary, elapsedMs: Date.now() - start };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { index, ok: false, error: { message }, elapsedMs: Date.now() - start };
    }
  });

  const collected = await runBoundedBranches(thunks, Math.floor(spec.maxConcurrency), spec.signal);
  if (collected.isErr()) {
    return err({ kind: "cancelled", reason: collected.error.message });
  }
  return ok(collected.value);
}

export async function storeBackedFanOut<S, D = unknown>(
  spec: StoreBackedFanOutSpec<S, D>,
): Promise<Result<readonly StoreBackedBranchOutcome<D>[], FanOutError>> {
  if (spec.branches.length === 0) {
    return err({ kind: "misconfigured", reason: "storeBackedFanOut requires at least one branch" });
  }
  if (!Number.isFinite(spec.maxConcurrency) || spec.maxConcurrency < 1) {
    return err({
      kind: "misconfigured",
      reason: `storeBackedFanOut maxConcurrency must be a finite integer >= 1 (got ${String(spec.maxConcurrency)})`,
    });
  }
  const budget = spec.summaryBudgetChars ?? DEFAULT_SUMMARY_BUDGET_CHARS;

  const thunks = spec.branches.map((branch, index) => async (): Promise<StoreBackedBranchOutcome<D>> => {
    const start = Date.now();
    let branchHash: StateHash | undefined;
    try {
      const branched = await spec.store.branch(spec.from);
      if (branched.isErr()) {
        return branchFailure(index, start, runtimeErrorMessage(branched.error));
      }
      branchHash = branched.value;
      const loaded = await spec.store.load(branchHash);
      if (loaded.isErr()) {
        return branchFailure(index, start, runtimeErrorMessage(loaded.error), branchHash);
      }
      const result = await branch(loaded.value, { index, branchHash });
      const saved = await spec.store.saveBranch(branchHash, result.state);
      if (saved.isErr()) {
        return branchFailure(index, start, runtimeErrorMessage(saved.error), branchHash, result.usage);
      }
      return {
        index,
        ok: true,
        branchHash,
        stateHash: saved.value,
        summary: condense(result.summary ?? { summary: `branch ${String(index)} completed` }, budget),
        elapsedMs: Date.now() - start,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return branchFailure(index, start, message, branchHash);
    }
  });

  const collected = await runBoundedBranches(thunks, Math.floor(spec.maxConcurrency), spec.signal);
  if (collected.isErr()) {
    return err({ kind: "cancelled", reason: collected.error.message });
  }
  return ok(collected.value);
}

export async function storeBackedFanIn<S, D = unknown>(
  policy: JoinPolicy,
  outcomes: readonly StoreBackedBranchOutcome<D>[],
  options: StoreBackedFanInOptions<S, D>,
): Promise<Result<S, FanInError | RuntimeError>> {
  const successes = outcomes.filter((outcome): outcome is Extract<StoreBackedBranchOutcome<D>, { ok: true }> => outcome.ok);
  const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.error]));

  const gate = applyPartialFailurePolicy(policy, successes.length, failures, options.onPartialFailure, options.quorum);
  if (gate.isErr()) {
    return err(gate.error);
  }

  const selected = selectByPolicy(policy, successes, options.quorum, options.agreeBy);
  if (selected.isErr()) {
    return err(selected.error);
  }

  const merged = await options.store.merge(
    selected.value.map((outcome) => outcome.stateHash),
    options.reducer,
  );
  if (merged.isErr()) {
    return err(merged.error);
  }
  return ok(merged.value);
}

/**
 * Join-policy fan-in (tasks 6.2, 6.4). Applies the partial-failure gate, then the join policy
 * selects which successful summaries count, then the reducer — the ONLY merge point — folds them
 * into one state. `barrier`/`reduce` fold every success; `race` folds the fastest; `quorum` folds
 * the first group of `quorum` branches to agree.
 */
export function fanIn<S, D = unknown>(
  policy: JoinPolicy,
  outcomes: readonly BranchOutcome<D>[],
  options: FanInOptions<S, D>,
): Result<S, FanInError> {
  const successes = outcomes.filter((outcome): outcome is SuccessOutcome<D> => outcome.ok);
  const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.error]));

  const gate = applyPartialFailurePolicy(policy, successes.length, failures, options.onPartialFailure, options.quorum);
  if (gate.isErr()) {
    return err(gate.error);
  }

  const selected = selectByPolicy(policy, successes, options.quorum, options.agreeBy);
  if (selected.isErr()) {
    return err(selected.error);
  }
  return ok(options.reducer(selected.value.map((outcome) => outcome.summary)));
}

/** Truncate an over-budget summary so a branch cannot return more than its share of context. */
function condense<D>(summary: BranchSummary<D>, budgetChars: number): BranchSummary<D> {
  if (summary.summary.length <= budgetChars) {
    return summary;
  }
  const truncation = "…[truncated]";
  const head = summary.summary.slice(0, Math.max(0, budgetChars - truncation.length));
  return { ...summary, summary: head + truncation };
}

/** Enough branches succeeded to proceed? Shared by every policy (design D9). */
function applyPartialFailurePolicy(
  policy: JoinPolicy,
  succeeded: number,
  failures: readonly BranchFailure[],
  onPartialFailure: PartialFailurePolicy | undefined,
  quorum: number | undefined,
): Result<void, FanInError> {
  if (succeeded === 0) {
    return err({ kind: "no-success", failures });
  }
  const resolved = onPartialFailure ?? defaultPartialFailure(policy, quorum);
  if (resolved.kind === "fail-fast" && failures.length > 0) {
    return err({ kind: "partial-failure", succeeded, failed: failures.length, failures });
  }
  if (resolved.kind === "tolerate" && succeeded < resolved.minSuccess) {
    return err({ kind: "partial-failure", succeeded, failed: failures.length, failures });
  }
  return ok(undefined);
}

function defaultPartialFailure(policy: JoinPolicy, quorum: number | undefined): PartialFailurePolicy {
  switch (policy) {
    case "barrier":
      return { kind: "fail-fast" };
    case "quorum":
      return { kind: "tolerate", minSuccess: quorum ?? 1 };
    case "race":
    case "reduce":
      return { kind: "tolerate", minSuccess: 1 };
  }
}

/** Which successful branches the reducer folds — guaranteed non-empty by the partial-failure gate. */
function selectByPolicy<D, T extends SelectableSuccess<D>>(
  policy: JoinPolicy,
  successes: readonly T[],
  quorum: number | undefined,
  agreeBy: ((summary: BranchSummary<D>) => unknown) | undefined,
): Result<readonly T[], FanInError> {
  switch (policy) {
    case "barrier":
    case "reduce":
      return ok(successes);
    case "race":
      return ok([successes.reduce((fastest, next) => (next.elapsedMs < fastest.elapsedMs ? next : fastest))]);
    case "quorum":
      return selectQuorum(successes, quorum, agreeBy);
  }
}

/** Self-consistency vote (design D9): the first group of `quorum` branches to agree wins. */
function selectQuorum<D, T extends SelectableSuccess<D>>(
  successes: readonly T[],
  quorum: number | undefined,
  agreeBy: ((summary: BranchSummary<D>) => unknown) | undefined,
): Result<readonly T[], FanInError> {
  if (quorum === undefined || quorum < 1) {
    return err({ kind: "misconfigured", reason: "quorum policy requires options.quorum >= 1" });
  }
  const keyOf = agreeBy ?? ((summary: BranchSummary<D>) => (summary.data === undefined ? summary.summary : summary.data));
  const groups = new Map<string, T[]>();
  let largestAgreement = 0;
  for (const outcome of successes) {
    const key = stableKey(keyOf(outcome.summary));
    const group = groups.get(key) ?? [];
    group.push(outcome);
    groups.set(key, group);
    largestAgreement = Math.max(largestAgreement, group.length);
    if (group.length >= quorum) {
      return ok(group); // proceed as soon as a quorum agrees, without waiting on the rest
    }
  }
  return err({ kind: "no-quorum", required: quorum, largestAgreement });
}

function branchFailure<D>(
  index: number,
  start: number,
  message: string,
  branchHash?: StateHash,
  usage?: Usage,
): StoreBackedBranchOutcome<D> {
  return {
    index,
    ok: false,
    error: { message },
    elapsedMs: Date.now() - start,
    ...(branchHash === undefined ? {} : { branchHash }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function runtimeErrorMessage(error: RuntimeError): string {
  switch (error._tag) {
    case "BackendFailed":
    case "FileSystemError":
    case "IoFailed":
      return error.message;
    case "UnsupportedFeature":
      return error.reason;
    case "CommandFailed":
      return error.stderr || error.stdout || `${error.command} failed`;
    case "TypecheckFailed":
      return error.stderr || error.stdout || "typecheck failed";
    case "PushRejected":
      return error.stderr;
    case "BranchAlreadyExists":
      return `branch already exists: ${error.branch}`;
    case "NothingToCommit":
      return "nothing to commit";
    case "StructuredOutputValidationFailed":
      return error.issues.join("; ");
  }
}

/** Order-independent serialization of an agreement key, so object field order never splits a vote. */
function stableKey(value: unknown): string {
  // Coalesce an undefined key to null first, so JSON.stringify always yields a string to group on.
  return JSON.stringify(sortKeys(value) ?? null);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}
