// Archetype: single-change
// One autonomous turn implements a change, then a verification gate (the target
// repo's own test + lint commands) converges via a bounded repair loop.
//
// SLOTS the author skill fills:
//   - TASK_PROMPT  : what to implement
//   - GATE         : the detected target-repo verification commands (>=1 test, >=1 lint)
//   - default backend (selectBackend default)
//
// Stack-agnostic: GATE commands are whatever THIS repo uses. Trigger:
//   orca .orca/workflows/<name>.ts --backend <tag>
import {
  command,
  fixLoop,
  flow,
  flowArgs,
  llm,
  ok,
  resolveBaselinePolicy,
  runBaselineGate,
  selectBackend,
} from "@twelvehart/orca-ts";

interface Cmd {
  readonly command: string;
  readonly args: readonly string[];
}

// ── VERIFICATION GATE — replace with THIS repo's real commands ──────────────
const GATE: readonly Cmd[] = [
  { command: "REPLACE_WITH_TEST_CMD", args: [] }, // e.g. { command: "pytest", args: ["-q"] }
  { command: "REPLACE_WITH_LINT_CMD", args: [] }, // e.g. { command: "ruff", args: ["check", "."] }
];

const TASK_PROMPT = "REPLACE_WITH_TASK_DESCRIPTION";

interface GateIssue {
  readonly message: string;
  readonly fixable: true;
}

await flow(flowArgs())(async () => {
  const selected = selectBackend({ default: "claude" });
  const baseline = resolveBaselinePolicy({ args: flowArgs() });
  try {
    await runBaselineGate({
      policy: baseline.policy,
      commands: GATE,
      repair: async (issues) => {
        const repair = await llm()
          .autonomous(selected.backend, {
            prompt: `The baseline verification gate failed before the main task:\n${issues
              .map((i) => i.message)
              .join("\n")}\nFix the baseline. Do not weaken the gate.`,
          })
          .awaitResult();
        if (repair.type !== "success") {
          throw new Error(`baseline repair turn failed: ${describeOutcome(repair)}`);
        }
        return { usage: repair.result.usage };
      },
    });

    const impl = await llm()
      .autonomous(selected.backend, { prompt: TASK_PROMPT })
      .awaitResult();
    if (impl.type !== "success") {
      throw new Error(`implementation turn failed: ${describeOutcome(impl)}`);
    }

    const seen = new Set<string>();
    const loop = await fixLoop<GateIssue>(
      async () => {
        const failure = await runGate(GATE);
        return ok(failure ? [{ message: failure, fixable: true as const }] : []);
      },
      async (issues) => {
        const detail = issues.map((i) => i.message).join("\n");
        const repair = await llm()
          .autonomous(selected.backend, {
            prompt: `The verification gate failed:\n${detail}\nFix the cause. Do not weaken the gate.`,
          })
          .awaitResult();
        if (repair.type !== "success") {
          throw new Error(`repair turn failed: ${describeOutcome(repair)}`);
        }
        return ok(undefined);
      },
      { maxIterations: 8, wallClockMs: 10 * 60_000, stalled: (issues) => stalled(seen, issues) },
    );

    if (loop.isErr() || !loop.value.converged) {
      const why = loop.isErr() ? JSON.stringify(loop.error) : loop.value.stop;
      throw new Error(`did not converge (${why}); changes left in place for inspection`);
    }
    console.log(`Converged in ${String(loop.value.iterations)} repair iteration(s).`);
  } finally {
    await selected.shutdown?.();
  }
});

async function runGate(commands: readonly Cmd[]): Promise<string | undefined> {
  for (const c of commands) {
    const result = await command().run({ command: c.command, args: c.args });
    if (result.type !== "success") {
      return `${c.command} ${c.args.join(" ")}\n${result.stderr || result.stdout}`;
    }
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
