import { describe, expect, test } from "bun:test";

import {
  loop,
  sessionId,
  times,
  untilGatesGreen,
  untilManifestComplete,
  type BackendResult,
  type BackendTag,
  type Conversation,
  type ConversationEvent,
  type GatesState,
  type LlmBackend,
  type LlmTool,
  type LoopVariant,
  type TaskManifest,
} from "../src/index.ts";

// L06 acceptance: the declarative loop() builder + preset archetypes lower onto flow() +
// generic fixLoop(). The single-cycle case reads like a guarded `while` — no Effect, queue, or
// conversation symbol in authored source.

/** A countdown state whose variant is just `n` driving toward 0. */
interface Countdown {
  readonly n: number;
}
const countdownVariant: LoopVariant<Countdown> = { measure: (state) => state.n };
const decrement = (state: Countdown): Countdown => ({ n: state.n - 1 });

const manifest = (passes: readonly boolean[]): TaskManifest => ({
  tasks: passes.map((p, i) => ({ id: `t${String(i)}`, passes: p })),
});

/** Flip the first still-pending task — one unit of manifest progress per cycle. */
const passOne = (state: TaskManifest): TaskManifest => {
  const index = state.tasks.findIndex((task) => !task.passes);
  if (index < 0) return state;
  return { tasks: state.tasks.map((task, i) => (i === index ? { ...task, passes: true } : task)) };
};

// --- Test-only fake LLM, so .reason() runs without a real backend (flow-runtime spec). ---

function emptyEvents(): AsyncIterable<ConversationEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve<IteratorResult<ConversationEvent, undefined>>({ done: true, value: undefined }),
    }),
  };
}

function fakeConversation<B extends BackendTag>(tag: B): Conversation<B> {
  const result: BackendResult<B> = { backend: tag, sessionId: sessionId(tag, "fake"), output: "done" };
  return {
    backend: tag,
    canAskUser: false,
    signal: new AbortController().signal,
    events: () => emptyEvents(),
    awaitResult: () => Promise.resolve({ type: "success", result }),
    cancel: () => Promise.resolve(),
  };
}

const fakeBackend: LlmBackend<"codex"> = { tag: "codex", autonomous: () => fakeConversation("codex") };

describe("loop() builder — single-cycle lowering (tasks 5.1, 5.3)", () => {
  test("loop().run does not route recurrence through the review module", async () => {
    const source = await Bun.file(`${import.meta.dir}/../src/loop/builder/index.ts`).text();

    expect(source).not.toContain("../../review");
    expect(source).not.toMatch(/\bfixLoop\s*\(/);
    expect(source).toContain("executeLoop");
  });

  test("a minimal single-cycle loop runs and returns a Result with a stop reason", async () => {
    const result = await loop<Countdown>("countdown")
      .step("decrement", decrement)
      .until(countdownVariant)
      .run({ n: 3 });

    // A neverthrow Result, not an engine Effect.
    expect(typeof result.isOk).toBe("function");
    const outcome = result._unsafeUnwrap();
    expect(outcome.stopReason).toBe("converged");
    expect(outcome.iterations).toBe(3);
    expect(outcome.state.n).toBe(0);
  });

  test("accessors and test overrides resolve from the run's flow context (.reason)", async () => {
    let reasonCalls = 0;
    const fakeLlm: LlmTool = {
      autonomous(backend, request) {
        reasonCalls += 1;
        void request;
        return fakeConversation(backend.tag);
      },
    };

    const result = await loop<Countdown>("reason-loop")
      .reason(fakeBackend, { prompt: "advance the work" })
      .step("decrement", decrement)
      .until(countdownVariant)
      .run({ n: 2 }, { overrides: { llm: fakeLlm } });

    const outcome = result._unsafeUnwrap();
    expect(outcome.stopReason).toBe("converged");
    expect(outcome.iterations).toBe(2);
    expect(reasonCalls).toBe(2);
  });
});

describe("preset archetypes (task 5.2)", () => {
  test("untilManifestComplete() derives the variant from pending-count with no author measure", async () => {
    const result = await loop<TaskManifest>("ralph")
      .step("pass-one", passOne)
      .until(untilManifestComplete())
      .run(manifest([false, false, false]));

    const outcome = result._unsafeUnwrap();
    expect(outcome.stopReason).toBe("converged");
    expect(outcome.iterations).toBe(3);
    expect(outcome.state.tasks.every((task) => task.passes)).toBe(true);
  });

  test(".measure(fn) overrides a preset and drives convergence", async () => {
    // The preset would read failingGates (already 0 ⇒ converge at iteration 0); the override
    // measures `remaining`, so the loop must run two cycles instead.
    interface GatedCountdown extends GatesState {
      readonly remaining: number;
    }

    const result = await loop<GatedCountdown>("override")
      .step("decrement", (state) => ({ ...state, remaining: state.remaining - 1 }))
      .until(untilGatesGreen())
      .measure((state) => state.remaining)
      .run({ failingGates: 0, remaining: 2 });

    const outcome = result._unsafeUnwrap();
    expect(outcome.stopReason).toBe("converged");
    expect(outcome.iterations).toBe(2);
    expect(outcome.state.remaining).toBe(0);
  });

  test("times(n) converges after n iterations and carries its own ceiling", async () => {
    const result = await loop("count-three")
      .step("noop", (state) => state)
      .until(times(3))
      .run();

    const outcome = result._unsafeUnwrap();
    expect(outcome.stopReason).toBe("converged");
    expect(outcome.iterations).toBe(3);
  });
});

describe("termination by construction + guards", () => {
  test("a back-edge with no variant is rejected, naming the cycle", async () => {
    const result = await loop("unguarded").step("work", (state) => state).run();

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error._tag).toBe("TerminationContractViolated");
    if (error._tag !== "TerminationContractViolated") throw new Error("expected a contract violation");
    expect(error.message).toContain("unguarded:work");
  });

  test(".guard({ maxIterations }) trips the ceiling when the measure never falls", async () => {
    const result = await loop<Countdown>("stuck-ceiling")
      .step("noop", (state) => state)
      .until(countdownVariant)
      .guard({ maxIterations: 2 })
      .run({ n: 5 });

    const outcome = result._unsafeUnwrap();
    expect(outcome.stopReason).toBe("ceiling");
    expect(outcome.iterations).toBe(2);
  });
});

describe("authoring surface is engine-internals-free (design D2)", () => {
  test("the public authoring type surface names no Effect/queue/conversation symbol", async () => {
    const source = await Bun.file(`${import.meta.dir}/../src/loop/builder/types.ts`).text();
    const importLines = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");

    expect(importLines).not.toMatch(/from ["']effect["']/);
    expect(importLines).not.toMatch(/\bConversation\b/);
    expect(importLines).not.toMatch(/\bQueue\b/);
  });
});
