// Archetype: bugfix (reproduce-first / TDD)
// Step 1: the agent writes a failing test that reproduces the bug.
// Step 2: confirm the gate is RED (the repro test fails) — proves the bug.
// Step 3: the agent fixes the cause; the gate (incl. the new test) converges GREEN.
// A fix that never goes red first is rejected: you cannot prove you fixed it.
//
// SLOTS the author skill fills:
//   - GATE       : detected target-repo verification commands (>=1 test, >=1 lint)
//   - BUG_REPORT : the bug description / reproduction notes
//   - default backend
import { command, fixLoop, flow, flowArgs, llm, ok, selectBackend } from "@twelvehart/orca-ts";

interface Cmd {
  readonly command: string;
  readonly args: readonly string[];
}

// ── VERIFICATION GATE — replace with THIS repo's real commands ──────────────
// The test command MUST include the repro test the agent adds in step 1.
const GATE: readonly Cmd[] = [
  { command: "REPLACE_WITH_TEST_CMD", args: [] },
  { command: "REPLACE_WITH_LINT_CMD", args: [] },
];

const BUG_REPORT = "REPLACE_WITH_BUG_REPORT";

interface GateIssue {
  readonly message: string;
  readonly fixable: true;
}

await flow(flowArgs())(async () => {
  const selected = selectBackend({ default: "claude" });
  try {
    // Step 0 — the gate must be GREEN before we start, or a pre-existing failure
    // would masquerade as a successful repro in Step 2.
    if ((await runGate(GATE)) !== undefined) {
      throw new Error(
        "baseline gate is already red — cannot prove a repro against a red baseline; fix that first",
      );
    }

    // Step 1 — write a failing test that reproduces the bug.
    const repro = await llm()
      .autonomous(selected.backend, {
        prompt:
          `Add a single, focused test that reproduces this bug. Do NOT fix the bug yet — the test must FAIL.\n\n${BUG_REPORT}`,
      })
      .awaitResult();
    if (repro.type !== "success") throw new Error(`repro turn failed: ${describeOutcome(repro)}`);

    // Step 2 — the gate must be red now, or the repro did not capture the bug.
    if ((await runGate(GATE)) === undefined) {
      throw new Error("repro test passed unexpectedly — the bug was not reproduced; aborting");
    }
    console.log("Bug reproduced (gate is red). Fixing…");

    // Step 3 — fix until the gate (including the repro test) is green.
    const seen = new Set<string>();
    const loop = await fixLoop<GateIssue>(
      async () => {
        const failure = await runGate(GATE);
        return ok(failure ? [{ message: failure, fixable: true as const }] : []);
      },
      async (issues) => {
        const repair = await llm()
          .autonomous(selected.backend, {
            prompt: `Fix the bug so this gate passes. Do not delete or weaken the repro test.\n${issues
              .map((i) => i.message)
              .join("\n")}`,
          })
          .awaitResult();
        if (repair.type !== "success") throw new Error(`fix turn failed: ${describeOutcome(repair)}`);
        return ok(undefined);
      },
      { maxIterations: 10, wallClockMs: 10 * 60_000, stalled: (i) => stalled(seen, i) },
    );

    if (loop.isErr() || !loop.value.converged) {
      const why = loop.isErr() ? JSON.stringify(loop.error) : loop.value.stop;
      throw new Error(`fix did not converge (${why})`);
    }
    console.log(`Bug fixed; gate green after ${String(loop.value.iterations)} iteration(s).`);
  } finally {
    await selected.shutdown?.();
  }
});

async function runGate(commands: readonly Cmd[]): Promise<string | undefined> {
  for (const c of commands) {
    const result = await command().run({ command: c.command, args: c.args });
    if (result.type !== "success") return `${c.command} ${c.args.join(" ")}\n${result.stderr || result.stdout}`;
  }
  return undefined;
}

function stalled(seen: Set<string>, issues: readonly GateIssue[]): boolean {
  const signature = issues
    .map((i) => i.message.replace(/\d+/g, "#").replace(/\/[^\s:]+/g, "/PATH"))
    .sort()
    .join("\n");
  if (seen.has(signature)) return true;
  seen.add(signature);
  return false;
}

function describeOutcome(outcome: { readonly type: string; readonly error?: unknown; readonly reason?: string }): string {
  if (outcome.type === "failed") return `failed: ${describeUnknown(outcome.error)}`;
  if (outcome.type === "cancelled") return outcome.reason ? `cancelled: ${outcome.reason}` : "cancelled";
  return outcome.type;
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
