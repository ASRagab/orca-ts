// Termination by construction (design D3 / tasks 4.5): enforced at build/lint time, before
// any loop runs. A beneficial cycle provably terminates only if its back-edge carries a loop
// variant — a measure bounded below that strictly decreases. The contract here rejects, with
// the offending cycle NAMED, two ways a loop graph violates that:
//
//   1. An ACCIDENTAL cycle — a back-edge the author never declared. Undeclared cycles have no
//      variant by definition and are reported.
//   2. An UNGUARDED declared back-edge — a declared loop whose head carries neither a preset
//      archetype nor a `.measure()` override.
//
// This module owns the SHAPE of the contract; it does not know about presets. It asks a
// caller-supplied `HasVariant` predicate whether a given loop-head node has a variant. L06
// satisfies that predicate by wiring preset archetypes (untilGatesGreen, untilManifestComplete,
// …) and `.measure()` overrides onto nodes. Effect-free (neverthrow only); kept internal — the
// builder surfaces the result, this file is not re-exported from ../index.ts.

import { err, ok, type Result } from "neverthrow";

import type { BackEdge, CycleReport, NodeId } from "./graph/index.ts";

/**
 * Predicate the contract queries per loop. L06 implements it by checking whether the back-edge's
 * head node has a bound preset archetype or `.measure()` variant. Queried with the back-edge
 * head (`BackEdge.to`) — the node a loop jumps back to.
 */
export type HasVariant = (node: NodeId) => boolean;

export type CycleViolationKind = "unguarded-back-edge" | "accidental-cycle";

export interface CycleViolation {
  readonly kind: CycleViolationKind;
  readonly backEdge: BackEdge;
  /** The cycle's node path, used to name it in the message. */
  readonly cycle: readonly NodeId[];
}

export interface TerminationContractError {
  readonly _tag: "TerminationContractViolated";
  readonly violations: readonly CycleViolation[];
  /** Human-readable summary naming every offending cycle. */
  readonly message: string;
}

/** Render a cycle path as `a → b → c → a` so the loop is named, not just counted. */
function nameCycle(cycle: readonly NodeId[]): string {
  const first = cycle[0];
  if (first === undefined) return "(empty)";
  if (cycle.length === 1) return `${first} → ${first}`;
  const last = cycle[cycle.length - 1];
  const closed = last === first ? cycle : [...cycle, first];
  return closed.join(" → ");
}

function describe(v: CycleViolation): string {
  const named = nameCycle(v.cycle);
  return v.kind === "accidental-cycle"
    ? `accidental cycle ${named} — declare it as a loop back-edge or remove an edge`
    : `unguarded back-edge ${v.backEdge.from} → ${v.backEdge.to} closing cycle ${named} — ` +
        `add a preset archetype or .measure() to node "${v.backEdge.to}"`;
}

/**
 * Enforce the termination contract over an analyzed loop graph. Returns `ok` when every cycle is
 * a declared loop back-edge whose head carries a variant; otherwise `err` naming each offending
 * cycle. Collects ALL violations in one pass so the author sees every problem at once.
 */
export function enforceTerminationContract(
  report: CycleReport,
  hasVariant: HasVariant
): Result<void, TerminationContractError> {
  const violations: CycleViolation[] = [];

  for (const backEdge of report.backEdges) {
    if (!backEdge.declared) {
      violations.push({ kind: "accidental-cycle", backEdge, cycle: backEdge.cycle });
    } else if (!hasVariant(backEdge.to)) {
      violations.push({ kind: "unguarded-back-edge", backEdge, cycle: backEdge.cycle });
    }
  }

  if (violations.length === 0) return ok(undefined);

  const count = violations.length;
  const message =
    `Loop graph violates termination by construction (${String(count)} ` +
    `${count === 1 ? "cycle" : "cycles"}): ${violations.map(describe).join("; ")}.`;

  return err({ _tag: "TerminationContractViolated", violations, message });
}
