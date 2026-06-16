import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { err, ok } from "neverthrow";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { flow, flowContext, type FsTool } from "../src/index.ts";
import {
  type EngineOutcome,
  engineFs,
  engineGit,
  engineLlm,
  fromResult,
  runBranches,
  runCancellable,
  runRecurrence,
  runToResult,
  toResult,
  withAmbientFlowContext,
} from "../src/loop/engine/index.ts";

/** A loop state whose variant is just its `remaining` count driving toward 0. */
interface Countdown {
  readonly remaining: number;
}

describe("loop engine — boundary bridge (Result ⟷ Effect)", () => {
  test("inward Result(ok) and the boundary runner return ok", async () => {
    const result = await runToResult(fromResult(ok(7)));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(7);
  });

  test("inward Result(err) surfaces as err with the original error", async () => {
    const result = await runToResult(fromResult(err(new Error("boom"))));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe("boom");
  });

  test("outward bridge collapses a typed failure into a Result inside Effect", async () => {
    const inner = await Effect.runPromise(toResult(Effect.fail(new Error("inner"))));
    expect(inner.isErr()).toBe(true);
    expect(inner._unsafeUnwrapErr().message).toBe("inner");
  });

  test("public call returns a neverthrow Result, not an Effect", async () => {
    const result = await runToResult(
      runRecurrence<Countdown>({
        initial: { remaining: 2 },
        iterate: (state) => Effect.succeed({ remaining: state.remaining - 1 }),
        measure: (state) => state.remaining,
      }),
    );
    // A neverthrow Result exposes isOk/isErr; an Effect would not.
    expect(typeof result.isOk).toBe("function");
    expect(typeof result.isErr).toBe("function");
  });
});

describe("loop engine — recurrence with variant stop (Schedule)", () => {
  test("drives the variant to its floor and reports converged", async () => {
    const result = await runToResult(
      runRecurrence<Countdown>({
        initial: { remaining: 5 },
        iterate: (state) => Effect.succeed({ remaining: state.remaining - 1 }),
        measure: (state) => state.remaining,
      }),
    );
    const outcome = result._unsafeUnwrap();
    expect(outcome.stopReason).toBe("converged");
    expect(outcome.measure).toBe(0);
    expect(outcome.iterations).toBe(5);
    expect(outcome.state.remaining).toBe(0);
  });

  test("stops at the iteration ceiling before converging", async () => {
    const result = await runToResult(
      runRecurrence<Countdown>({
        initial: { remaining: 5 },
        iterate: (state) => Effect.succeed({ remaining: state.remaining - 1 }),
        measure: (state) => state.remaining,
        maxIterations: 3,
      }),
    );
    const outcome = result._unsafeUnwrap();
    expect(outcome.stopReason).toBe("ceiling");
    expect(outcome.iterations).toBe(3);
    expect(outcome.measure).toBe(2);
  });

  test("a failing iteration surfaces as err at the boundary", async () => {
    const result = await runToResult(
      runRecurrence<Countdown>({
        initial: { remaining: 5 },
        iterate: (state) =>
          state.remaining === 3
            ? Effect.fail(new Error("iteration failed"))
            : Effect.succeed({ remaining: state.remaining - 1 }),
        measure: (state) => state.remaining,
      }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe("iteration failed");
  });
});

describe("loop engine — bounded structured concurrency", () => {
  test("runs all branches and returns their results", async () => {
    const result = await runToResult(
      runBranches({
        branches: [Effect.succeed(1), Effect.succeed(2), Effect.succeed(3)],
        concurrency: 2,
      }),
    );
    expect(result._unsafeUnwrap()).toEqual([1, 2, 3]);
  });

  test("honors the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const branch = Effect.gen(function* () {
      active += 1;
      peak = Math.max(peak, active);
      yield* Effect.sleep("5 millis");
      active -= 1;
      return 0;
    });
    const result = await runToResult(
      runBranches({ branches: Array.from({ length: 6 }, () => branch), concurrency: 2 }),
    );
    expect(result.isOk()).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("loop engine — structured cancellation", () => {
  test("cancellation interrupts in-flight branches and yields a cancelled outcome", async () => {
    const branchCount = 4;
    let started = 0;
    let interrupted = 0;
    const allStarted = Promise.withResolvers<undefined>();
    const controller = new AbortController();

    const branch = Effect.sync(() => {
      started += 1;
      if (started === branchCount) {
        allStarted.resolve(undefined);
      }
    }).pipe(
      Effect.zipRight(Effect.never),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted += 1;
        }),
      ),
    );

    const converged: EngineOutcome<null> = { state: null, stopReason: "converged", iterations: 1, measure: 0 };
    const cancelled: EngineOutcome<null> = { state: null, stopReason: "cancelled", iterations: 0, measure: 0 };

    const work = runBranches({
      branches: Array.from({ length: branchCount }, () => branch),
      concurrency: branchCount,
    }).pipe(Effect.as(converged));

    // Abort only once every branch has started, so the interruption is deterministic.
    void allStarted.promise.then(() => {
      controller.abort();
    });

    const result = await runToResult(runCancellable(work, () => cancelled, controller.signal));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().stopReason).toBe("cancelled");
    expect(started).toBe(branchCount);
    expect(interrupted).toBe(branchCount);
  });

  test("without a signal the work runs to completion unchanged", async () => {
    const converged: EngineOutcome<null> = { state: null, stopReason: "converged", iterations: 1, measure: 0 };
    const result = await runToResult(runCancellable(Effect.succeed(converged), () => converged));
    expect(result._unsafeUnwrap().stopReason).toBe("converged");
  });
});

describe("loop engine — Layer DI resolves the flow context", () => {
  test("engine accessors resolve the same context, including test overrides", async () => {
    const fakeFs: FsTool = {
      readText: () => Promise.resolve(ok("override")),
      writeText: () => Promise.resolve(ok(undefined)),
      exists: () => Promise.resolve(true),
    };

    await flow([], { fs: fakeFs })(async () => {
      const ctx = flowContext();
      // The plain boundary captures the ambient context; the engine sees it via a Layer.
      const program = withAmbientFlowContext(
        Effect.all([engineFs, engineGit, engineLlm]).pipe(
          Effect.map(([resolvedFs, resolvedGit, resolvedLlm]) => ({
            fsIsOverride: resolvedFs === fakeFs,
            gitMatches: resolvedGit === ctx.git,
            llmMatches: resolvedLlm === ctx.llm,
          })),
        ),
      );
      const result = await runToResult(program);
      expect(result._unsafeUnwrap()).toEqual({ fsIsOverride: true, gitMatches: true, llmMatches: true });
    });
  });
});

describe("facade gate forbids Effect in the authoring surface", () => {
  const gateScript = join(import.meta.dir, "..", "scripts", "check-facade-gate.ts");

  function runGate(root: string): { exitCode: number; stderr: string } {
    const proc = Bun.spawnSync(["bun", "run", gateScript], {
      env: { ...process.env, ORCA_FACADE_GATE_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
  }

  function seedRoot(file: string, contents: string): string {
    const root = mkdtempSync(join(tmpdir(), "orca-facade-gate-"));
    mkdirSync(join(root, "examples"), { recursive: true });
    writeFileSync(join(root, "examples", file), contents);
    return root;
  }

  test("fails verification when an example flow references an Effect type", () => {
    const root = seedRoot(
      "leak.ts",
      'import { Effect } from "effect";\nexport const leak: Effect.Effect<number, never> = Effect.succeed(1);\n',
    );
    try {
      const { exitCode, stderr } = runGate(root);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("examples/leak.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes when the scanned flow files expose only Result/plain types", () => {
    const root = seedRoot(
      "clean.ts",
      'import { ok } from "neverthrow";\nexport const clean = ok(1);\n',
    );
    try {
      const { exitCode } = runGate(root);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
