import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamConversation, codex, sessionId, z, type CodexProcess } from "../src/index.ts";
import {
  errorMessage,
  runSubprocessConversation,
  spawnSubprocess,
  splitLines
} from "../src/backends/subprocess-run.ts";
import { terminateSubprocess } from "../src/backends/subprocess-termination.ts";

describe("Codex live backend constructor", () => {
  test("starts codex exec JSONL and returns normalized conversation output", async () => {
    let command = "";
    let args: readonly string[] = [];
    const backend = codex({
      command: "codex-test",
      model: "gpt-5",
      spawnProcess: (actualCommand, actualArgs) => {
        command = actualCommand;
        args = actualArgs;
        return fakeProcess([
          { type: "thread.started", thread_id: "codex-live" },
          { type: "item.completed", item: { id: "msg", type: "agent_message", text: "done" } },
          {
            type: "turn.completed",
            usage: { input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 3 }
          }
        ]);
      }
    });

    const conversation = backend.autonomous({ prompt: "inspect the repo" });
    const events = drainEvents(conversation.events());
    const outcome = await conversation.awaitResult();

    expect(command).toBe("codex-test");
    expect(args).toEqual(["exec", "--json", "--model", "gpt-5", "inspect the repo"]);
    expect(await events).toEqual([
      { type: "assistant_text_delta", text: "done" },
      { type: "assistant_turn_end" }
    ]);
    expect(outcome).toEqual({
      type: "success",
        result: {
          backend: "codex",
        sessionId: sessionId("codex", "codex-live"),
          output: "done",
          usage: { input: 1, output: 2, reasoning: 3 }
        }
    });
  });

  test("maps autonomous request reasoning effort to Codex args", async () => {
    let args: readonly string[] = [];
    const backend = codex({
      reasoningEffort: "high",
      config: { reasoningEffort: "medium" },
      spawnProcess: (_command, actualArgs) => {
        args = actualArgs;
        return fakeProcess([
          { type: "thread.started", thread_id: "codex-reasoning" },
          { type: "item.completed", item: { id: "msg", type: "agent_message", text: "done" } },
          { type: "turn.completed" }
        ]);
      }
    });

    await backend.autonomous({
      prompt: "rank candidates",
      config: { reasoningEffort: "low" }
    }).awaitResult();

    expect(args).toEqual([
      "exec",
      "--json",
      "-c",
      "model_reasoning_effort=\"low\"",
      "rank candidates"
    ]);
  });

  test("reports startup failures as backend failures", async () => {
    const backend = codex({
      spawnProcess: () => {
        throw new Error("codex missing");
      }
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome).toEqual({
      type: "failed",
      error: { _tag: "BackendFailed", backend: "codex", message: "codex missing" }
    });
  });

  test("reports malformed JSONL as a backend failure", async () => {
    const backend = codex({
      spawnProcess: () => fakeProcess(["not json"])
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome.type).toBe("failed");
    if (outcome.type === "failed") {
      expect(outcome.error._tag).toBe("BackendFailed");
      if (outcome.error._tag === "BackendFailed") {
        expect(outcome.error.message).toContain("invalid codex JSONL");
      }
    }
  });

  test("reports non-zero exit with stderr as a backend failure", async () => {
    const backend = codex({
      spawnProcess: () => fakeProcess([], { exitCode: 2, stderr: ["not authenticated"] })
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "codex exited with code 2: not authenticated"
      }
    });
  });

  test("inactivity timeout waits for subprocess exit before failing", async () => {
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const signals: NodeJS.Signals[] = [];
    const backend = codex({
      inactivityTimeoutMs: 20,
      wallClockTimeoutMs: 1_000,
      spawnProcess: () => ({
        stdout: neverStream(),
        stderr: lineStream([]),
        exit: exit.promise,
        kill: (signal = "SIGTERM") => {
          signals.push(signal);
          terminationStarted.resolve(undefined);
        }
      })
    });

    const outcome = backend.autonomous({ prompt: "run" }).awaitResult();
    await terminationStarted.promise;
    const beforeExit = await Promise.race([
      outcome.then(() => "settled" as const),
      delay(10).then(() => "pending" as const)
    ]);
    exit.resolve(null);

    expect(beforeExit).toBe("pending");
    expect(signals).toEqual(["SIGTERM"]);
    expect(await outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "codex emitted no stdout for 20ms; treating the turn as stalled"
      }
    });
  });

  test("wall-clock timeout ignores terminal lines until subprocess exit", async () => {
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const signals: NodeJS.Signals[] = [];
    const backend = codex({
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 30,
      spawnProcess: () => ({
        stdout: postTimeoutTerminalStream(terminationStarted.promise),
        stderr: lineStream([]),
        exit: exit.promise,
        kill: (signal = "SIGTERM") => {
          signals.push(signal);
          terminationStarted.resolve(undefined);
        }
      })
    });

    const outcome = backend.autonomous({ prompt: "run" }).awaitResult();
    await terminationStarted.promise;
    const beforeExit = await Promise.race([
      outcome.then(() => "settled" as const),
      delay(10).then(() => "pending" as const)
    ]);
    exit.resolve(null);

    expect(beforeExit).toBe("pending");
    expect(signals).toEqual(["SIGTERM"]);
    expect(await outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "codex turn exceeded 30ms wall-clock limit"
      }
    });
  });

  test("wall-clock timeout reserves settlement during a blocked terminal consume", async () => {
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const backend = codex({
      capacity: 1,
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 20,
      spawnProcess: () => ({
        stdout: lineStream([
          JSON.stringify({
            type: "item.completed",
            item: { id: "msg", type: "agent_message", text: "queued" }
          }),
          JSON.stringify({ type: "turn.completed" })
        ]),
        stderr: lineStream([]),
        exit: exit.promise,
        kill: () => {
          terminationStarted.resolve(undefined);
        }
      })
    });

    const conversation = backend.autonomous({ prompt: "run" });
    const events = conversation.events()[Symbol.asyncIterator]();
    const outcome = conversation.awaitResult();
    await terminationStarted.promise;
    expect(await events.next()).toEqual({
      value: { type: "assistant_text_delta", text: "queued" },
      done: false
    });
    const beforeExit = await Promise.race([
      outcome.then(() => "settled" as const),
      delay(10).then(() => "pending" as const)
    ]);
    exit.resolve(null);

    expect(beforeExit).toBe("pending");
    expect(await outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "codex turn exceeded 20ms wall-clock limit"
      }
    });
  });

  test("timeout reports termination rejection before late terminal success", async () => {
    const terminationStarted = Promise.withResolvers<undefined>();
    const terminationError = new Error("exit observation failed");
    const exit = Promise.reject<number | null>(terminationError);
    void exit.catch(() => undefined);
    const backend = codex({
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 5,
      spawnProcess: () => ({
        stdout: postTimeoutTerminalStream(terminationStarted.promise),
        stderr: lineStream([]),
        exit,
        kill: () => {
          terminationStarted.resolve(undefined);
        }
      })
    });

    const outcome = backend.autonomous({ prompt: "run" }).awaitResult();
    const result = await Promise.race([
      outcome,
      delay(50).then(() => "pending" as const)
    ]);

    expect(result).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "exit observation failed"
      }
    });
  });

  test("timeout settles when stdout rejects during subprocess termination", async () => {
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const backend = codex({
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 5,
      spawnProcess: () => ({
        stdout: rejectingStream(
          terminationStarted.promise,
          new Error("stdout failed during termination")
        ),
        stderr: lineStream([]),
        exit: exit.promise,
        kill: () => {
          terminationStarted.resolve(undefined);
        }
      })
    });

    const outcome = backend.autonomous({ prompt: "run" }).awaitResult();
    await terminationStarted.promise;
    await Promise.resolve();
    exit.resolve(null);
    const result = await Promise.race([
      outcome,
      delay(50).then(() => "pending" as const)
    ]);

    expect(result).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "codex turn exceeded 5ms wall-clock limit"
      }
    });
  });

  test("timeout settles when stderr remains open after subprocess exit", async () => {
    const terminationStarted = Promise.withResolvers<undefined>();
    const backend = codex({
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 5,
      spawnProcess: () => ({
        stdout: lineStream([]),
        stderr: neverStream(),
        exit: Promise.resolve(0),
        kill: () => {
          terminationStarted.resolve(undefined);
        }
      })
    });

    const outcome = backend.autonomous({ prompt: "run" }).awaitResult();
    await terminationStarted.promise;
    const result = await Promise.race([
      outcome,
      delay(50).then(() => "pending" as const)
    ]);

    expect(result).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "codex turn exceeded 5ms wall-clock limit"
      }
    });
  });

  test("timeout finalizes stdout and stderr before settlement", async () => {
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const stdoutCleanupStarted = Promise.withResolvers<undefined>();
    const stdoutCleanup = Promise.withResolvers<undefined>();
    const stderrCleanupStarted = Promise.withResolvers<undefined>();
    const stderrCleanup = Promise.withResolvers<undefined>();
    const backend = codex({
      inactivityTimeoutMs: 0,
      wallClockTimeoutMs: 60_000,
      spawnProcess: () => ({
        stdout: lineStreamWithBlockedReturn(
          [],
          stdoutCleanupStarted,
          stdoutCleanup.promise
        ),
        stderr: lineStreamWithBlockedReturn(
          [],
          stderrCleanupStarted,
          stderrCleanup.promise
        ),
        exit: exit.promise,
        kill: () => {
          terminationStarted.resolve(undefined);
        }
      })
    });

    const outcome = backend.autonomous({ prompt: "run" }).awaitResult();
    await terminationStarted.promise;
    exit.resolve(null);

    try {
      const cleanupState = await Promise.race([
        Promise.all([
          stdoutCleanupStarted.promise,
          stderrCleanupStarted.promise
        ]).then(() => "started" as const),
        outcome.then(() => "settled" as const)
      ]);
      expect(cleanupState).toBe("started");

      stdoutCleanup.resolve(undefined);
      const beforeStderrCleanup = await Promise.race([
        outcome.then(() => "settled" as const),
        delay(10).then(() => "pending" as const)
      ]);
      expect(beforeStderrCleanup).toBe("pending");
    } finally {
      exit.resolve(null);
      stdoutCleanup.resolve(undefined);
      stderrCleanup.resolve(undefined);
    }

    expect(await outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "codex emitted no stdout for 0ms; treating the turn as stalled"
      }
    });
  });

  test("timeout reports stream cleanup failure after returning stderr iterator", async () => {
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const backend = codex({
      inactivityTimeoutMs: 0,
      wallClockTimeoutMs: 60_000,
      spawnProcess: () => ({
        stdout: neverStream(),
        stderr: destroyThrowingCancellableStream(stderrReturned),
        exit: exit.promise,
        kill: () => {
          terminationStarted.resolve(undefined);
        }
      })
    });

    const outcome = backend.autonomous({ prompt: "run" }).awaitResult();
    await terminationStarted.promise;
    exit.resolve(null);

    const cleanupState = await Promise.race([
      stderrReturned.promise.then(() => "returned" as const),
      outcome.then(() => "settled" as const)
    ]);

    expect(cleanupState).toBe("returned");
    expect(await outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "stream destruction failed"
      }
    });
  });

  test("timeout cleanup failure rejects cancellation that starts during teardown", async () => {
    const exit = Promise.withResolvers<number | null>();
    const stdoutCleanupStarted = Promise.withResolvers<undefined>();
    const stdoutCleanup = Promise.withResolvers<undefined>();
    const cleanupError = new Error("timeout cleanup failed during cancellation");
    const backend = codex({
      inactivityTimeoutMs: 0,
      wallClockTimeoutMs: 1_000,
      spawnProcess: () => ({
        stdout: lineStreamWithBlockedReturn(
          [],
          stdoutCleanupStarted,
          stdoutCleanup.promise
        ),
        stderr: lineStream([]),
        exit: exit.promise,
        kill: () => {
          exit.resolve(null);
        }
      })
    });

    const conversation = backend.autonomous({ prompt: "run" });
    const outcome = conversation.awaitResult();
    await stdoutCleanupStarted.promise;
    const caught = conversation.cancel("stop").then(
      () => undefined,
      (error: unknown) => error
    );
    stdoutCleanup.reject(cleanupError);

    expect(await outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message:
          "codex cancellation cleanup failed: timeout cleanup failed during cancellation"
      }
    });
    expect(await caught).toBe(cleanupError);
  });

  test("does not overwrite a normal terminal result with timeout handling", async () => {
    const backend = codex({
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 1_000,
      spawnProcess: () =>
        fakeProcess([
          { type: "thread.started", thread_id: "codex-timeout-ok" },
          { type: "item.completed", item: { id: "msg", type: "agent_message", text: "done" } },
          { type: "turn.completed" }
        ])
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome).toEqual({
      type: "success",
      result: {
        backend: "codex",
        sessionId: sessionId("codex", "codex-timeout-ok"),
        output: "done",
        usage: { input: 0, output: 0 }
      }
    });
  });

  test("terminal consumer outcome waits for subprocess exit and cleanup", async () => {
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const stdoutCleanupStarted = Promise.withResolvers<undefined>();
    const stdoutCleanup = Promise.withResolvers<undefined>();
    const stderrCleanup = Promise.withResolvers<undefined>();
    const signals: NodeJS.Signals[] = [];
    const backend = codex({
      spawnProcess: () => ({
        stdout: lineStreamWithBlockedReturn([
          JSON.stringify({ type: "thread.started", thread_id: "codex-terminal-cleanup" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "msg", type: "agent_message", text: "done" }
          }),
          JSON.stringify({ type: "turn.completed" })
        ], stdoutCleanupStarted, stdoutCleanup.promise),
        stderr: blockedStream(stderrCleanup.promise),
        exit: exit.promise,
        kill: (signal = "SIGTERM") => {
          signals.push(signal);
          terminationStarted.resolve(undefined);
        }
      })
    });

    const outcome = backend.autonomous({ prompt: "run" }).awaitResult();
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    try {
      await terminationStarted.promise;
      await Promise.resolve();
      expect(settled).toBe(false);

      exit.resolve(null);
      const cleanupStart = await Promise.race([
        stdoutCleanupStarted.promise.then(() => "started" as const),
        delay(25).then(() => "pending" as const)
      ]);
      expect(cleanupStart).toBe("started");
      await Promise.resolve();
      expect(settled).toBe(false);

      stdoutCleanup.resolve(undefined);
      const beforeStderrCleanup = await Promise.race([
        outcome.then(() => "settled" as const),
        delay(10).then(() => "pending" as const)
      ]);
      expect(beforeStderrCleanup).toBe("pending");
    } finally {
      exit.resolve(null);
      stdoutCleanup.resolve(undefined);
      stderrCleanup.resolve(undefined);
    }

    expect(signals).toEqual(["SIGTERM"]);
    expect(await outcome).toEqual({
      type: "success",
      result: {
        backend: "codex",
        sessionId: sessionId("codex", "codex-terminal-cleanup"),
        output: "done",
        usage: { input: 0, output: 0 }
      }
    });
  });

  test("consumer cleanup failure rejects cancellation that starts during teardown", async () => {
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const stdoutCleanupStarted = Promise.withResolvers<undefined>();
    const stdoutCleanup = Promise.withResolvers<undefined>();
    const cleanupError = new Error("consumer cleanup failed during cancellation");
    const backend = codex({
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 1_000,
      spawnProcess: () => ({
        stdout: lineStreamWithBlockedReturn([
          JSON.stringify({ type: "thread.started", thread_id: "codex-consumer-cancel" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "msg", type: "agent_message", text: "done" }
          }),
          JSON.stringify({ type: "turn.completed" })
        ], stdoutCleanupStarted, stdoutCleanup.promise),
        stderr: lineStream([]),
        exit: exit.promise,
        kill: () => {
          terminationStarted.resolve(undefined);
        }
      })
    });

    const conversation = backend.autonomous({ prompt: "run" });
    const outcome = conversation.awaitResult();
    await terminationStarted.promise;
    const caught = conversation.cancel("stop").then(
      () => undefined,
      (error: unknown) => error
    );
    exit.resolve(null);
    await stdoutCleanupStarted.promise;
    stdoutCleanup.reject(cleanupError);

    expect(await outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message:
          "codex cancellation cleanup failed: consumer cleanup failed during cancellation"
      }
    });
    expect(await caught).toBe(cleanupError);
  });

  test("consumer teardown releases settlement at the absolute wall-clock deadline", async () => {
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const backend = codex({
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 40,
      spawnProcess: () => ({
        stdout: lineStream([
          JSON.stringify({ type: "thread.started", thread_id: "codex-stderr-deadline" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "msg", type: "agent_message", text: "done" }
          }),
          JSON.stringify({ type: "turn.completed" })
        ]),
        stderr: neverReturningStream(Promise.withResolvers<undefined>()),
        exit: exit.promise,
        kill: () => {
          terminationStarted.resolve(undefined);
          exit.resolve(null);
        }
      })
    });

    const outcome = backend.autonomous({ prompt: "run" }).awaitResult();
    await terminationStarted.promise;

    expect(
      await Promise.race([
        outcome,
        delay(250).then(() => "pending" as const)
      ])
    ).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "subprocess stream teardown exceeded 40ms wall-clock limit"
      }
    });
  });

  test("terminal cleanup returns stdout after termination failure", async () => {
    const stdoutReturned = Promise.withResolvers<undefined>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const terminationError = new Error("terminal termination failed");
    const chunks = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-cleanup-failure" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "msg", type: "agent_message", text: "done" }
      }),
      JSON.stringify({ type: "turn.completed" })
    ];
    let chunkIndex = 0;
    const stdout: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            if (chunkIndex < chunks.length) {
              const value = `${chunks[chunkIndex] ?? ""}\n`;
              chunkIndex += 1;
              return { done: false, value };
            }
            return new Promise<IteratorResult<string>>(() => undefined);
          },
          return(): Promise<IteratorResult<string>> {
            stdoutReturned.resolve(undefined);
            return Promise.reject(new Error("stdout cleanup failed"));
          }
        };
      }
    };
    const backend = codex({
      spawnProcess: () => ({
        stdout,
        stderr: cancellableBlockedStream(stderrReturned),
        exit: new Promise<number | null>(() => undefined),
        kill: () => {
          throw terminationError;
        }
      })
    });

    const outcome = backend.autonomous({ prompt: "run" }).awaitResult();
    const returned = await Promise.race([
      stdoutReturned.promise.then(() => "returned" as const),
      delay(10).then(() => "pending" as const)
    ]);
    const stderrState = await Promise.race([
      stderrReturned.promise.then(() => "returned" as const),
      delay(10).then(() => "pending" as const)
    ]);

    expect(returned).toBe("returned");
    expect(stderrState).toBe("returned");
    expect(await outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: terminationError.message
      }
    });
  });

  test("startup failure terminates the subprocess and finalizes streams", async () => {
    const startError = new Error("start failed");
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const stdoutReturned = Promise.withResolvers<undefined>();
    const stdoutComplete = Promise.withResolvers<undefined>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const stderrComplete = Promise.withResolvers<undefined>();
    const conversation = new StreamConversation({ backend: "codex" });
    const running = runSubprocessConversation({
      backend: "codex",
      command: "codex",
      args: [],
      conversation,
      spawnProcess: () => ({
        stdout: controlledCancellableStream(stdoutReturned, stdoutComplete.promise),
        stderr: controlledCancellableStream(stderrReturned, stderrComplete.promise),
        exit: exit.promise,
        kill: () => {
          terminationStarted.resolve(undefined);
        }
      }),
      onStart: () => {
        throw startError;
      },
      createConsumer: () => ({
        signal: new AbortController().signal,
        consume: () => Promise.resolve(),
        finish: () => undefined
      })
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    const firstState = await Promise.race([
      terminationStarted.promise.then(() => "terminating" as const),
      running.then(() => "returned" as const)
    ]);
    expect(firstState).toBe("terminating");

    try {
      exit.resolve(null);
      expect(await running).toBe(startError);
      expect(await Promise.race([
        stdoutReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("returned");
      expect(await Promise.race([
        stderrReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("returned");
    } finally {
      exit.resolve(null);
      stdoutComplete.resolve(undefined);
      stderrComplete.resolve(undefined);
    }
  });

  test("consumer failure terminates the subprocess and finalizes streams", async () => {
    const consumeError = new Error("consume failed");
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const stdoutReturned = Promise.withResolvers<undefined>();
    const stdoutComplete = Promise.withResolvers<undefined>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const stderrComplete = Promise.withResolvers<undefined>();
    const conversation = new StreamConversation({ backend: "codex" });
    const running = runSubprocessConversation({
      backend: "codex",
      command: "codex",
      args: [],
      conversation,
      spawnProcess: () => ({
        stdout: lineThenCancellableStream(
          "line\n",
          stdoutReturned,
          stdoutComplete.promise
        ),
        stderr: controlledCancellableStream(stderrReturned, stderrComplete.promise),
        exit: exit.promise,
        kill: () => {
          terminationStarted.resolve(undefined);
        }
      }),
      createConsumer: () => ({
        signal: new AbortController().signal,
        consume: () => Promise.reject(consumeError),
        finish: () => undefined
      })
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    const firstState = await Promise.race([
      terminationStarted.promise.then(() => "terminating" as const),
      running.then(() => "returned" as const)
    ]);
    expect(firstState).toBe("terminating");

    try {
      exit.resolve(null);
      expect(await running).toBe(consumeError);
      expect(await Promise.race([
        stdoutReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("returned");
      expect(await Promise.race([
        stderrReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("returned");
    } finally {
      exit.resolve(null);
      stdoutComplete.resolve(undefined);
      stderrComplete.resolve(undefined);
    }
  });

  test("consumer failure routes concurrent cancellation cleanup failure", async () => {
    const consumeError = new Error("consume failed before cancellation");
    const cleanupError = new Error("stdout cleanup failed during cancellation");
    const terminationStarted = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const stdoutReturned = Promise.withResolvers<undefined>();
    const stdout: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          next(): Promise<IteratorResult<string>> {
            if (!emitted) {
              emitted = true;
              return Promise.resolve({ done: false, value: "line\n" });
            }
            return new Promise<IteratorResult<string>>(() => undefined);
          },
          return(): Promise<IteratorResult<string>> {
            stdoutReturned.resolve(undefined);
            return Promise.reject(cleanupError);
          }
        };
      }
    };
    const conversation = new StreamConversation({ backend: "codex" });
    const running = runSubprocessConversation({
      backend: "codex",
      command: "codex",
      args: [],
      conversation,
      spawnProcess: () => ({
        stdout,
        stderr: lineStream([]),
        exit: exit.promise,
        kill: () => {
          terminationStarted.resolve(undefined);
        }
      }),
      createConsumer: () => ({
        signal: new AbortController().signal,
        consume: () => Promise.reject(consumeError),
        finish: () => undefined
      })
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    await terminationStarted.promise;
    const cancellation = conversation.cancel("stop").then(
      () => undefined,
      (error: unknown) => error
    );
    exit.resolve(null);

    const runError = await running;
    const cancellationError = await cancellation;
    const outcome = await conversation.awaitResult();

    expect({
      runPreserved: runError === consumeError,
      cancellationPreserved: cancellationError === cleanupError,
      outcome
    }).toEqual({
      runPreserved: true,
      cancellationPreserved: true,
      outcome: {
        type: "failed",
        error: {
          _tag: "BackendFailed",
          backend: "codex",
          message:
            "codex cancellation cleanup failed: stdout cleanup failed during cancellation"
        }
      }
    });
    expect(runError).toBe(consumeError);
    expect(cancellationError).toBe(cleanupError);
    await stdoutReturned.promise;
    expect(outcome.type).toBe("failed");
  });

  test("failed cancellation after stdout EOF finalizes the active run", async () => {
    const stdoutEnded = Promise.withResolvers<undefined>();
    const stdoutReturned = Promise.withResolvers<undefined>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const stderrComplete = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const exitWaitStarted = Promise.withResolvers<undefined>();
    const cancellationError = new Error("termination failed after EOF");
    const process: CodexProcess = {
      stdout: emptyCancellableStream(stdoutEnded, stdoutReturned),
      stderr: controlledCancellableStream(stderrReturned, stderrComplete.promise),
      get exit() {
        exitWaitStarted.resolve(undefined);
        return exit.promise;
      },
      kill: () => {
        throw cancellationError;
      }
    };
    const conversation = new StreamConversation({
      backend: "codex",
      onCancel: async () => {
        process.kill("SIGTERM");
        await process.exit;
      }
    });
    const running = runSubprocessConversation({
      backend: "codex",
      command: "codex",
      args: [],
      conversation,
      spawnProcess: () => process,
      createConsumer: () => ({
        signal: new AbortController().signal,
        consume: () => Promise.resolve(),
        finish: () => undefined
      })
    });

    await stdoutEnded.promise;
    await exitWaitStarted.promise;
    const caught = await conversation.cancel("stop").then(
      () => undefined,
      (error: unknown) => error
    );

    try {
      expect(caught).toBe(cancellationError);
      expect(await Promise.race([
        running.then(() => "settled" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("settled");
      expect(await Promise.race([
        stdoutReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("returned");
      expect(await Promise.race([
        stderrReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("returned");
    } finally {
      exit.resolve(null);
      stderrComplete.resolve(undefined);
      await running.catch(() => undefined);
    }

    expect(await conversation.awaitResult()).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "codex cancellation cleanup failed: termination failed after EOF"
      }
    });
  });

  test("successful cancellation interrupts the post-EOF stderr wait", async () => {
    const stdoutEnded = Promise.withResolvers<undefined>();
    const stdoutReturned = Promise.withResolvers<undefined>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const stderrComplete = Promise.withResolvers<undefined>();
    const exitResolved = Promise.withResolvers<number | null>();
    const exitObserved = Promise.withResolvers<undefined>();
    const exit = exitResolved.promise.then((code) => {
      exitObserved.resolve(undefined);
      return code;
    });
    const process: CodexProcess = {
      stdout: emptyCancellableStream(stdoutEnded, stdoutReturned),
      stderr: controlledCancellableStream(stderrReturned, stderrComplete.promise),
      exit,
      kill: () => undefined
    };
    const conversation = new StreamConversation({
      backend: "codex",
      onCancel: async () => {
        process.kill("SIGTERM");
        await process.exit;
      }
    });
    const running = runSubprocessConversation({
      backend: "codex",
      command: "codex",
      args: [],
      conversation,
      spawnProcess: () => process,
      createConsumer: () => ({
        signal: new AbortController().signal,
        consume: () => Promise.resolve(),
        finish: () => undefined
      })
    });

    await stdoutEnded.promise;
    exitResolved.resolve(0);
    await exitObserved.promise;
    await Promise.resolve();
    const cancellation = conversation.cancel("stop");

    try {
      expect(await Promise.race([
        cancellation.then(() => "settled" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("settled");
      expect(await Promise.race([
        running.then(() => "settled" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("settled");
      expect(await Promise.race([
        stderrReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("returned");
    } finally {
      exitResolved.resolve(0);
      stderrComplete.resolve(undefined);
      await cancellation.catch(() => undefined);
      await running.catch(() => undefined);
    }

    expect(await conversation.awaitResult()).toEqual({
      type: "cancelled",
      reason: "stop"
    });
  });

  test("cancels the child process", async () => {
    let killed = false;
    const stdoutBlocked = Promise.withResolvers<undefined>();
    const backend = codex({
      spawnProcess: () => ({
        stdout: blockedStream(stdoutBlocked.promise),
        stderr: lineStream([]),
        exit: stdoutBlocked.promise.then(() => null),
        kill: () => {
          killed = true;
          stdoutBlocked.resolve(undefined);
        }
      })
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await Promise.resolve();
    await conversation.cancel("stop");

    expect(killed).toBe(true);
    expect(await conversation.awaitResult()).toEqual({ type: "cancelled", reason: "stop" });
  });

  test("cancellation waits for the Codex child to exit", async () => {
    const spawned = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const signals: NodeJS.Signals[] = [];
    const backend = codex({
      spawnProcess: () => {
        spawned.resolve(undefined);
        return {
          stdout: blockedStream(exit.promise.then(() => undefined)),
          stderr: lineStream([]),
          exit: exit.promise,
          kill: (signal = "SIGTERM") => {
            signals.push(signal);
          }
        };
      }
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await spawned.promise;
    const cancellation = conversation.cancel("stop");
    const beforeExit = await Promise.race([
      cancellation.then(() => "settled" as const),
      delay(10).then(() => "pending" as const)
    ]);
    exit.resolve(null);
    await cancellation;

    expect(signals).toEqual(["SIGTERM"]);
    expect(beforeExit).toBe("pending");
    expect(await conversation.awaitResult()).toEqual({
      type: "cancelled",
      reason: "stop"
    });
  });

  test("successful cancellation waits for stdout and stderr cleanup after exit", async () => {
    const spawned = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const stdoutCleanup = Promise.withResolvers<undefined>();
    const stderrCleanup = Promise.withResolvers<undefined>();
    const backend = codex({
      spawnProcess: () => {
        spawned.resolve(undefined);
        return {
          stdout: blockedStream(stdoutCleanup.promise),
          stderr: blockedStream(stderrCleanup.promise),
          exit: exit.promise,
          kill: () => undefined
        };
      }
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await spawned.promise;
    const cancellation = conversation.cancel("stop");

    try {
      exit.resolve(null);
      const beforeStdoutCleanup = await Promise.race([
        cancellation.then(() => "settled" as const),
        delay(10).then(() => "pending" as const)
      ]);
      expect(beforeStdoutCleanup).toBe("pending");

      stdoutCleanup.resolve(undefined);
      const beforeStderrCleanup = await Promise.race([
        cancellation.then(() => "settled" as const),
        delay(10).then(() => "pending" as const)
      ]);
      expect(beforeStderrCleanup).toBe("pending");
    } finally {
      exit.resolve(null);
      stdoutCleanup.resolve(undefined);
      stderrCleanup.resolve(undefined);
      await cancellation.catch(() => undefined);
    }

    expect(await conversation.awaitResult()).toEqual({
      type: "cancelled",
      reason: "stop"
    });
  });

  test("successful cancellation reports stream cleanup failure after all teardown", async () => {
    const spawned = Promise.withResolvers<undefined>();
    const stdoutCleanupStarted = Promise.withResolvers<undefined>();
    const stderrCleanupStarted = Promise.withResolvers<undefined>();
    const stdoutCleanup = Promise.withResolvers<undefined>();
    const stderrCleanup = Promise.withResolvers<undefined>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const cleanupError = new Error("stdout cleanup failed");
    const backend = codex({
      spawnProcess: () => {
        spawned.resolve(undefined);
        return {
          stdout: lineStreamWithBlockedReturn(
            [],
            stdoutCleanupStarted,
            stdoutCleanup.promise
          ),
          stderr: lineStreamWithBlockedReturn(
            [],
            stderrCleanupStarted,
            stderrCleanup.promise,
            stderrReturned
          ),
          exit: exit.promise,
          kill: () => undefined
        };
      }
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await spawned.promise;
    const settlementOrder: string[] = [];
    const outcome = conversation.awaitResult().then((value) => {
      settlementOrder.push("outcome");
      return value;
    });
    const cancellation = conversation.cancel("stop");
    expect(conversation.cancel("ignored")).toBe(cancellation);
    const caught = cancellation.then(
      () => undefined,
      (error: unknown) => {
        settlementOrder.push("rejection");
        return error;
      }
    );

    try {
      exit.resolve(null);
      expect(
        await Promise.race([
          Promise.all([
            stdoutCleanupStarted.promise,
            stderrCleanupStarted.promise
          ]).then(() => "started" as const),
          delay(25).then(() => "pending" as const)
        ])
      ).toBe("started");
      expect(settlementOrder).toEqual([]);

      stdoutCleanup.reject(cleanupError);
      expect(
        await Promise.race([
          Promise.all([outcome, caught]).then(() => "settled" as const),
          delay(10).then(() => "pending" as const)
        ])
      ).toBe("pending");
      expect(settlementOrder).toEqual([]);

      stderrCleanup.resolve(undefined);
      await stderrReturned.promise;
    } finally {
      exit.resolve(null);
      stdoutCleanup.reject(cleanupError);
      stderrCleanup.resolve(undefined);
    }

    expect(await outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "codex cancellation cleanup failed: stdout cleanup failed"
      }
    });
    expect(await caught).toBe(cleanupError);
    expect(settlementOrder).toEqual(["outcome", "rejection"]);
  });

  test("cancellation bounds hung stdout and stderr iterator returns", async () => {
    const spawned = Promise.withResolvers<undefined>();
    const stdoutReturned = Promise.withResolvers<undefined>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const backend = codex({
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 40,
      spawnProcess: () => {
        spawned.resolve(undefined);
        return {
          stdout: neverReturningStream(stdoutReturned),
          stderr: neverReturningStream(stderrReturned),
          exit: exit.promise,
          kill: () => {
            exit.resolve(null);
          }
        };
      }
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await spawned.promise;
    const outcome = conversation.awaitResult();
    const caught = conversation.cancel("stop").then(
      () => undefined,
      (error: unknown) => errorMessage(error)
    );

    expect(
      await Promise.race([
        Promise.all([outcome, caught]),
        delay(250).then(() => "pending" as const)
      ])
    ).toEqual([
      {
        type: "failed",
        error: {
          _tag: "BackendFailed",
          backend: "codex",
          message:
            "codex cancellation cleanup failed: subprocess stream teardown exceeded 40ms wall-clock limit"
        }
      },
      "subprocess stream teardown exceeded 40ms wall-clock limit"
    ]);
    expect(
      await Promise.all([
        stdoutReturned.promise.then(() => "stdout" as const),
        stderrReturned.promise.then(() => "stderr" as const)
      ])
    ).toEqual(["stdout", "stderr"]);
  });

  test("buffered stdout after cancellation finalizes streams before settlement", async () => {
    const spawned = Promise.withResolvers<undefined>();
    const bufferedLine = Promise.withResolvers<string>();
    const bufferedLineDelivered = Promise.withResolvers<undefined>();
    const stdoutReturned = Promise.withResolvers<undefined>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const signals: NodeJS.Signals[] = [];
    let delivered = false;
    const stdout: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        const blocked = Promise.withResolvers<IteratorResult<string>>();
        return {
          async next(): Promise<IteratorResult<string>> {
            if (!delivered) {
              delivered = true;
              const value = await bufferedLine.promise;
              bufferedLineDelivered.resolve(undefined);
              return { done: false, value };
            }
            return blocked.promise;
          },
          return: () => {
            stdoutReturned.resolve(undefined);
            const done = { done: true, value: undefined } as const;
            blocked.resolve(done);
            return Promise.resolve(done);
          }
        };
      }
    };
    const backend = codex({
      spawnProcess: () => {
        spawned.resolve(undefined);
        return {
          stdout,
          stderr: cancellableBlockedStream(stderrReturned),
          exit: exit.promise,
          kill: (signal = "SIGTERM") => {
            signals.push(signal);
            bufferedLine.resolve(`${JSON.stringify({ type: "thread.started", thread_id: "buffered" })}\n`);
          }
        };
      }
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await spawned.promise;
    const cancellation = conversation.cancel("stop");

    try {
      await bufferedLineDelivered.promise;
      exit.resolve(null);
      const stdoutState = await Promise.race([
        stdoutReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ]);
      const stderrState = await Promise.race([
        stderrReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ]);
      expect(stdoutState).toBe("returned");
      expect(stderrState).toBe("returned");
    } finally {
      bufferedLine.resolve("\n");
      exit.resolve(null);
      await cancellation.catch(() => undefined);
    }

    expect(signals).toEqual(["SIGTERM"]);
    expect(await conversation.awaitResult()).toEqual({
      type: "cancelled",
      reason: "stop"
    });
  });

  test("failed cancellation waits for held stdout and stderr teardown", async () => {
    const spawned = Promise.withResolvers<undefined>();
    const stdoutCleanupStarted = Promise.withResolvers<undefined>();
    const stderrCleanupStarted = Promise.withResolvers<undefined>();
    const stdoutCleanup = Promise.withResolvers<undefined>();
    const stderrCleanup = Promise.withResolvers<undefined>();
    const stdoutReturned = Promise.withResolvers<undefined>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const cancellationError = new Error("process refused termination");
    const backend = codex({
      spawnProcess: () => {
        spawned.resolve(undefined);
        return {
          stdout: lineStreamWithBlockedReturn(
            [],
            stdoutCleanupStarted,
            stdoutCleanup.promise,
            stdoutReturned
          ),
          stderr: lineStreamWithBlockedReturn(
            [],
            stderrCleanupStarted,
            stderrCleanup.promise,
            stderrReturned
          ),
          exit: exit.promise,
          kill: () => {
            throw cancellationError;
          }
        };
      }
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await spawned.promise;
    const settlementOrder: string[] = [];
    const outcome = conversation.awaitResult().then((value) => {
      settlementOrder.push("outcome");
      return value;
    });
    const caught = conversation.cancel("stop").then(
      () => undefined,
      (error: unknown) => {
        settlementOrder.push("rejection");
        return error;
      }
    );

    try {
      expect(
        await Promise.race([
          Promise.all([
            stdoutCleanupStarted.promise,
            stderrCleanupStarted.promise
          ]).then(() => "started" as const),
          delay(25).then(() => "pending" as const)
        ])
      ).toBe("started");
      expect(settlementOrder).toEqual([]);

      stdoutCleanup.resolve(undefined);
      await stdoutReturned.promise;
      expect(settlementOrder).toEqual([]);

      stderrCleanup.resolve(undefined);
      await stderrReturned.promise;
    } finally {
      stdoutCleanup.resolve(undefined);
      stderrCleanup.resolve(undefined);
      exit.resolve(null);
    }

    expect(await outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "codex",
        message: "codex cancellation cleanup failed: process refused termination"
      }
    });
    expect(await caught).toBe(cancellationError);
    expect(settlementOrder).toEqual(["outcome", "rejection"]);
  });

  test("cancellation interrupts a blocked consumer and runs stream cleanup", async () => {
    const consumeStarted = Promise.withResolvers<undefined>();
    const consumeRelease = Promise.withResolvers<undefined>();
    const stdoutReturned = Promise.withResolvers<undefined>();
    const stdoutComplete = Promise.withResolvers<undefined>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const stderrComplete = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const stdout = lineThenCancellableStream(
      "buffered line\n",
      stdoutReturned,
      stdoutComplete.promise
    );
    const process: CodexProcess = {
      stdout,
      stderr: controlledCancellableStream(stderrReturned, stderrComplete.promise),
      exit: exit.promise,
      kill: () => undefined
    };
    const conversation = new StreamConversation({
      backend: "codex",
      onCancel: async () => {
        process.kill("SIGTERM");
        await process.exit;
      }
    });
    const consumerAbort = new AbortController();
    const running = runSubprocessConversation({
      backend: "codex",
      command: "codex",
      args: [],
      conversation,
      spawnProcess: () => process,
      createConsumer: () => ({
        signal: consumerAbort.signal,
        async consume() {
          consumeStarted.resolve(undefined);
          await consumeRelease.promise;
        },
        finish: () => undefined
      })
    });

    await consumeStarted.promise;
    const cancellation = conversation.cancel("stop");

    try {
      exit.resolve(null);
      const cancellationState = await Promise.race([
        cancellation.then(() => "settled" as const),
        delay(25).then(() => "pending" as const)
      ]);
      expect(cancellationState).toBe("settled");
      expect(await Promise.race([
        stdoutReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("returned");
      expect(await Promise.race([
        stderrReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("returned");
    } finally {
      exit.resolve(null);
      consumeRelease.resolve(undefined);
      stdoutComplete.resolve(undefined);
      stderrComplete.resolve(undefined);
      await running.catch(() => undefined);
    }

    expect(await conversation.awaitResult()).toEqual({
      type: "cancelled",
      reason: "stop"
    });
  });

  test("cancellation drains an active timeout reservation before settlement", async () => {
    const timeoutStarted = Promise.withResolvers<undefined>();
    const stdoutReturned = Promise.withResolvers<undefined>();
    const stderrReturned = Promise.withResolvers<undefined>();
    const stdoutComplete = Promise.withResolvers<undefined>();
    const stderrComplete = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const backend = codex({
      inactivityTimeoutMs: 0,
      wallClockTimeoutMs: 60_000,
      spawnProcess: () => ({
        stdout: controlledCancellableStream(stdoutReturned, stdoutComplete.promise),
        stderr: controlledCancellableStream(stderrReturned, stderrComplete.promise),
        exit: exit.promise,
        kill: () => {
          timeoutStarted.resolve(undefined);
        }
      })
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await timeoutStarted.promise;
    const cancellation = conversation.cancel("stop");

    try {
      exit.resolve(null);
      const cancellationState = await Promise.race([
        cancellation.then(() => "settled" as const),
        delay(25).then(() => "pending" as const)
      ]);
      expect(cancellationState).toBe("settled");
      expect(await Promise.race([
        stdoutReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("returned");
      expect(await Promise.race([
        stderrReturned.promise.then(() => "returned" as const),
        delay(25).then(() => "pending" as const)
      ])).toBe("returned");
    } finally {
      exit.resolve(null);
      stdoutComplete.resolve(undefined);
      stderrComplete.resolve(undefined);
    }

    expect(await conversation.awaitResult()).toEqual({
      type: "cancelled",
      reason: "stop"
    });
  });

  test("bounded cancellation escalates to SIGKILL and still waits for exit", async () => {
    const exit = Promise.withResolvers<number | null>();
    const signals: NodeJS.Signals[] = [];
    const process: CodexProcess = {
      stdout: lineStream([]),
      exit: exit.promise,
      kill: (signal = "SIGTERM") => {
        signals.push(signal);
      }
    };

    const termination = terminateSubprocess(process, 5, 50);
    await delay(15);
    const beforeExit = await Promise.race([
      termination.then(() => "settled" as const),
      delay(5).then(() => "pending" as const)
    ]);
    exit.resolve(null);
    await termination;

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(beforeExit).toBe("pending");
  });

  test("bounded cancellation rejects when SIGKILL cannot produce exit", async () => {
    const signals: NodeJS.Signals[] = [];
    const process: CodexProcess = {
      stdout: lineStream([]),
      exit: new Promise<number | null>(() => {}),
      kill: (signal = "SIGTERM") => {
        signals.push(signal);
      }
    };

    let terminationError: unknown;
    try {
      await terminateSubprocess(process, 1, 1);
    } catch (error) {
      terminationError = error;
    }
    expect(terminationError).toBeInstanceOf(Error);
    expect((terminationError as Error).message).toBe(
      "subprocess did not exit after SIGKILL"
    );
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("failed termination cancels injected process-group polling timer", async () => {
    if (process.platform === "win32") {
      return;
    }

    const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
    const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const originalKill = process.kill.bind(process);
    const activePollTimers = new Set<ReturnType<typeof setTimeout>>();
    let pollSchedules = 0;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((callback: (...args: unknown[]) => void, delayMs?: number, ...args: unknown[]) => {
        const timer = originalSetTimeout(() => {
          activePollTimers.delete(timer);
          callback(...args);
        }, delayMs);
        if (delayMs === 10) {
          pollSchedules += 1;
          activePollTimers.add(timer);
        }
        return timer;
      }) as typeof setTimeout
    );
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
      ((timer: ReturnType<typeof setTimeout> | undefined) => {
        if (timer !== undefined) {
          activePollTimers.delete(timer);
          originalClearTimeout(timer);
        }
      }) as typeof clearTimeout
    );
    const killSpy = spyOn(process, "kill").mockImplementation(
      (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid < 0) {
          return true;
        }
        return originalKill(pid, signal);
      }
    );
    let spawnedProcess: CodexProcess | undefined;

    try {
      spawnedProcess = spawnSubprocess(process.execPath, ["-e", ""], {});
      await waitFor(() => pollSchedules > 0);
      const terminationError = await terminateSubprocess(spawnedProcess, 1, 1).then(
        () => undefined,
        (error: unknown) => error
      );
      const exitError = await Promise.race([
        spawnedProcess.exit.then(
          () => undefined,
          (error: unknown) => error
        ),
        new Promise<"pending">((resolve) => {
          originalSetTimeout(() => {
            resolve("pending");
          }, 25);
        })
      ]);
      const schedulesAtFailure = pollSchedules;

      expect((terminationError as Error).message).toBe(
        "subprocess did not exit after SIGKILL"
      );
      expect(exitError).toBe(terminationError);
      await new Promise<void>((resolve) => {
        originalSetTimeout(resolve, 35);
      });

      expect(pollSchedules).toBe(schedulesAtFailure);
      expect(activePollTimers.size).toBe(0);
    } finally {
      killSpy.mockRestore();
      timeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      await spawnedProcess?.exit.catch(() => undefined);
    }
  });

  test("real POSIX termination signals and reaps the subprocess group", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "orca-subprocess-group-"));
    const readyPath = join(root, "grandchild-ready");
    const leaderTermPath = join(root, "leader-term");
    const grandchildTermPath = join(root, "grandchild-term");
    let spawnedProcess: CodexProcess | undefined;
    let leaderPid: number | undefined;
    let grandchildPid: number | undefined;

    const grandchildSource = [
      'const { appendFileSync, writeFileSync } = require("node:fs");',
      `process.on("SIGTERM", () => appendFileSync(${JSON.stringify(grandchildTermPath)}, "term\\n"));`,
      `writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);"
    ].join("\n");
    const leaderSource = [
      'const { appendFileSync, existsSync } = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `process.on("SIGTERM", () => appendFileSync(${JSON.stringify(leaderTermPath)}, "term\\n"));`,
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });`,
      "const announce = () => {",
      `  if (existsSync(${JSON.stringify(readyPath)})) {`,
      "    console.log(JSON.stringify({ leader: process.pid, grandchild: child.pid }));",
      "    return;",
      "  }",
      "  setTimeout(announce, 5);",
      "};",
      "announce();",
      "setInterval(() => {}, 1000);"
    ].join("\n");

    try {
      spawnedProcess = spawnSubprocess(process.execPath, ["-e", leaderSource], {});
      const identity = JSON.parse(await firstLine(spawnedProcess.stdout)) as {
        readonly leader: number;
        readonly grandchild: number;
      };
      leaderPid = identity.leader;
      grandchildPid = identity.grandchild;
      expect(isProcessAlive(leaderPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      await terminateSubprocess(spawnedProcess, 100, 1_000);
      await waitFor(() => !isProcessAlive(identity.leader) && !isProcessAlive(identity.grandchild));

      expect(existsSync(leaderTermPath)).toBe(true);
      expect(existsSync(grandchildTermPath)).toBe(true);
      expect(isProcessAlive(identity.leader)).toBe(false);
      expect(isProcessAlive(identity.grandchild)).toBe(false);
    } finally {
      if (spawnedProcess !== undefined) {
        await terminateSubprocess(spawnedProcess, 0, 1_000).catch(() => undefined);
      }
      killProcess(leaderPid);
      killProcess(grandchildPid);
      await waitFor(
        () => !isProcessAlive(leaderPid) && !isProcessAlive(grandchildPid),
        1_000
      ).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not spawn after immediate cancellation", async () => {
    let spawned = false;
    const backend = codex({
      spawnProcess: () => {
        spawned = true;
        return fakeProcess([]);
      }
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await conversation.cancel("stop");
    await Promise.resolve();

    expect(spawned).toBe(false);
    expect(await conversation.awaitResult()).toEqual({ type: "cancelled", reason: "stop" });
  });

  test("does not spawn when interactive setup observes cancellation", async () => {
    let cancellation: Promise<void> | undefined;
    let spawned = false;
    const backend = codex({
      askUser: () => "yes",
      createAskUserServer: ({ responder }) => ({
        get url() {
          cancellation = conversation.cancel("stop during setup");
          return "http://127.0.0.1:12345";
        },
        ask: async (request) => await responder(request),
        close: () => Promise.resolve()
      }),
      spawnProcess: () => {
        spawned = true;
        return fakeProcess([]);
      }
    });

    const conversation = backend.autonomous({
      prompt: "run",
      config: { interactive: true }
    });
    await Promise.resolve();
    await cancellation;

    expect(spawned).toBe(false);
    expect(await conversation.awaitResult()).toEqual({
      type: "cancelled",
      reason: "stop during setup"
    });
  });

  test("maps backend config to codex args and prompt composition", async () => {
    let args: readonly string[] = [];
    const backend = codex({
      command: "codex-test",
      ignoreUserConfig: true,
      config: {
        model: "gpt-5",
        approvalPolicy: "never",
        readOnly: true,
        selfManagedGit: false,
        systemPrompt: "Prefer small diffs.",
        retry: { attempts: 2 }
      },
      spawnProcess: (_command, actualArgs) => {
        args = actualArgs;
        return fakeProcess([
          { type: "thread.started", thread_id: "codex-config" },
          { type: "item.completed", item: { id: "msg", type: "agent_message", text: "done" } },
          { type: "turn.completed" }
        ]);
      }
    });

    await backend.autonomous({ prompt: "implement task" }).awaitResult();

    expect(args.slice(0, 9)).toEqual([
      "exec",
      "--json",
      "--ignore-user-config",
      "--model",
      "gpt-5",
      "-c",
      "approval_policy=\"never\"",
      "--sandbox",
      "read-only"
    ]);
    const prompt = args.at(-1);
    expect(prompt).toContain("Prefer small diffs.");
    expect(prompt).toContain("Do not create commits");
    expect(prompt).toContain("maximum attempts 2");
    expect(prompt).toContain("implement task");
  });

  test("resumes Codex sessions with branded session handles", async () => {
    let args: readonly string[] = [];
    const backend = codex({
      spawnProcess: (_command, actualArgs) => {
        args = actualArgs;
        return fakeProcess([
          { type: "thread.started", thread_id: "codex-next" },
          { type: "item.completed", item: { id: "msg", type: "agent_message", text: "next" } },
          { type: "turn.completed" }
        ]);
      }
    });

    const outcome = await backend
      .autonomous({
        prompt: "continue",
        config: { resumeSessionId: sessionId("codex", "codex-prev") }
      })
      .awaitResult();

    expect(args).toEqual(["exec", "resume", "--json", "codex-prev", "continue"]);
    expect(outcome.type).toBe("success");
    if (outcome.type === "success") {
      expect(String(outcome.result.sessionId)).toBe("codex-next");
    }
  });

  test("passes output schema files to Codex and returns structured values", async () => {
    let schemaText = "";
    let args: readonly string[] = [];
    const backend = codex({
      spawnProcess: (_command, actualArgs) => {
        args = actualArgs;
        const schemaPath = actualArgs[actualArgs.indexOf("--output-schema") + 1];
        if (schemaPath === undefined) {
          throw new Error("missing output schema path");
        }
        schemaText = readFileSync(schemaPath, "utf8");
        return fakeProcess([
          { type: "thread.started", thread_id: "codex-structured" },
          {
            type: "item.completed",
            item: { id: "msg", type: "agent_message", text: "{\"answer\":\"yes\"}" }
          },
          { type: "turn.completed" }
        ]);
      }
    });

    const outcome = await backend
      .autonomous({ prompt: "answer as JSON", schema: z.object({ answer: z.string() }) })
      .awaitResult();

    expect(args).toContain("--output-schema");
    expect(schemaText).toContain("\"answer\"");
    expect(outcome).toEqual({
      type: "success",
      result: {
        backend: "codex",
        sessionId: sessionId("codex", "codex-structured"),
        output: "{\"answer\":\"yes\"}",
        structured: { answer: "yes" },
        usage: { input: 0, output: 0 }
      }
    });
  });

  test("surfaces interactive ask_user as a question; the answer arrives on item.completed", async () => {
    // The answer is routed by the Orcats MCP HTTP bridge (responder), not the
    // consumer; Codex re-emits it on the matching `item.completed`. So the
    // consumer must emit the question for display and turn that completion into
    // the tool_result — without invoking the responder a second time.
    let args: readonly string[] = [];
    let closeBridge!: () => void;
    const closed = new Promise<void>((resolve) => {
      closeBridge = resolve;
    });
    const backend = codex({
      askUser: ({ question }) => `answer:${question}`,
      createAskUserServer: ({ responder }) => ({
        url: "http://127.0.0.1:12345",
        ask: async (request) => await responder(request),
        close: () => {
          closeBridge();
          return Promise.resolve();
        }
      }),
      spawnProcess: (_command, actualArgs) => {
        args = actualArgs;
        return fakeProcess([
          { type: "thread.started", thread_id: "codex-interactive" },
          {
            type: "item.started",
            item: {
              id: "ask_1",
              type: "mcp_tool_call",
              server: "orcats",
              tool: "ask_user",
              arguments: { question: "Continue?" }
            }
          },
          {
            type: "item.completed",
            item: {
              id: "ask_1",
              type: "mcp_tool_call",
              server: "orcats",
              tool: "ask_user",
              result: { content: [{ text: "answer:Continue?" }] }
            }
          },
          { type: "item.completed", item: { id: "msg", type: "agent_message", text: "done" } },
          { type: "turn.completed" }
        ]);
      }
    });

    const conversation = backend.autonomous({ prompt: "run", config: { interactive: true } });
    const events = drainEvents(conversation.events());
    const outcome = await conversation.awaitResult();

    expect(conversation.canAskUser).toBe(true);
    expect(args).toContain("mcp_servers.orcats.url=\"http://127.0.0.1:12345\"");
    expect(await events).toEqual([
      { type: "user_question", question: "Continue?" },
      { type: "tool_result", toolCallId: "ask_1", output: "answer:Continue?" },
      { type: "assistant_text_delta", text: "done" },
      { type: "assistant_turn_end" }
    ]);
    expect(outcome.type).toBe("success");
    await closed;
  });

  test("cleans up ask_user bridge on startup failure", async () => {
    let closed = false;
    const backend = codex({
      askUser: () => "yes",
      createAskUserServer: ({ responder }) => ({
        url: "http://127.0.0.1:12345",
        ask: async (request) => await responder(request),
        close: () => {
          closed = true;
          return Promise.resolve();
        }
      }),
      spawnProcess: () => {
        throw new Error("boom");
      }
    });

    const outcome = await backend
      .autonomous({ prompt: "run", config: { interactive: true } })
      .awaitResult();

    expect(outcome).toEqual({
      type: "failed",
      error: { _tag: "BackendFailed", backend: "codex", message: "boom" }
    });
    expect(closed).toBe(true);
  });

  test("cleans up ask_user bridge on cancellation", async () => {
    const stdoutBlocked = Promise.withResolvers<undefined>();
    const closed = Promise.withResolvers<undefined>();
    const backend = codex({
      askUser: () => "yes",
      createAskUserServer: ({ responder }) => ({
        url: "http://127.0.0.1:12345",
        ask: async (request) => await responder(request),
        close: () => {
          closed.resolve(undefined);
          return Promise.resolve();
        }
      }),
      spawnProcess: () => ({
        stdout: blockedStream(stdoutBlocked.promise),
        stderr: lineStream([]),
        exit: stdoutBlocked.promise.then(() => null),
        kill: () => {
          stdoutBlocked.resolve(undefined);
        }
      })
    });

    const conversation = backend.autonomous({ prompt: "run", config: { interactive: true } });
    await Promise.resolve();
    await conversation.cancel("stop");
    await closed.promise;
  });
});

type JsonLine = string | Record<string, unknown>;

function fakeProcess(
  stdout: readonly JsonLine[],
  options: { readonly exitCode?: number | null; readonly stderr?: readonly string[] } = {}
): CodexProcess {
  return {
    stdout: lineStream(stdout.map((line) => (typeof line === "string" ? line : JSON.stringify(line)))),
    stderr: lineStream(options.stderr ?? []),
    exit: Promise.resolve(options.exitCode ?? 0),
    kill: () => {}
  };
}

async function* lineStream(lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) {
    await Promise.resolve();
    yield `${line}\n`;
  }
}

function neverStream(): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const next = Promise.withResolvers<IteratorResult<string>>();
      return {
        next: () => next.promise,
        return: () => {
          const done = { done: true, value: undefined } as const;
          next.resolve(done);
          return Promise.resolve(done);
        }
      };
    }
  };
}

function neverReturningStream(
  returned: {
    resolve(value: undefined | PromiseLike<undefined>): void;
  }
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<string>>(() => undefined),
        return: () => {
          returned.resolve(undefined);
          return new Promise<IteratorResult<string>>(() => undefined);
        }
      };
    }
  };
}

async function* postTimeoutTerminalStream(
  terminationStarted: Promise<undefined>
): AsyncIterable<string> {
  yield `${JSON.stringify({ type: "thread.started", thread_id: "codex-active" })}\n`;
  await terminationStarted;
  yield `${JSON.stringify({ type: "turn.completed" })}\n`;
}

function rejectingStream(
  blocked: Promise<undefined>,
  error: Error
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          await blocked;
          throw error;
        },
        return(): Promise<IteratorResult<string>> {
          return Promise.resolve({ done: true, value: undefined });
        }
      };
    }
  };
}

function delay(ms: number): Promise<undefined> {
  const gate = Promise.withResolvers<undefined>();
  setTimeout(() => {
    gate.resolve(undefined);
  }, ms);
  return gate.promise;
}

async function* blockedStream(blocked: Promise<undefined>): AsyncIterable<string> {
  await blocked;
  yield* [];
}

function cancellableBlockedStream(
  returned: {
    resolve(value: undefined | PromiseLike<undefined>): void;
  }
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const next = Promise.withResolvers<IteratorResult<string>>();
      return {
        next: () => next.promise,
        return: () => {
          returned.resolve(undefined);
          const done = { done: true, value: undefined } as const;
          next.resolve(done);
          return Promise.resolve(done);
        }
      };
    }
  };
}

function destroyThrowingCancellableStream(
  returned: {
    resolve(value: undefined | PromiseLike<undefined>): void;
  }
): AsyncIterable<string> & { destroy(): never } {
  return {
    destroy() {
      throw new Error("stream destruction failed");
    },
    [Symbol.asyncIterator]() {
      const next = Promise.withResolvers<IteratorResult<string>>();
      return {
        next: () => next.promise,
        return: () => {
          returned.resolve(undefined);
          const done = { done: true, value: undefined } as const;
          next.resolve(done);
          return Promise.resolve(done);
        }
      };
    }
  };
}

function emptyCancellableStream(
  ended: {
    resolve(value: undefined | PromiseLike<undefined>): void;
  },
  returned: {
    resolve(value: undefined | PromiseLike<undefined>): void;
  }
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const done = { done: true, value: undefined } as const;
      return {
        next: () => {
          ended.resolve(undefined);
          return Promise.resolve(done);
        },
        return: () => {
          returned.resolve(undefined);
          return Promise.resolve(done);
        }
      };
    }
  };
}

function controlledCancellableStream(
  returned: {
    resolve(value: undefined | PromiseLike<undefined>): void;
  },
  complete: Promise<undefined>
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const next = Promise.withResolvers<IteratorResult<string>>();
      void complete.then(() => {
        next.resolve({ done: true, value: undefined });
      });
      return {
        next: () => next.promise,
        return: () => {
          returned.resolve(undefined);
          const done = { done: true, value: undefined } as const;
          next.resolve(done);
          return Promise.resolve(done);
        }
      };
    }
  };
}

function lineThenCancellableStream(
  line: string,
  returned: {
    resolve(value: undefined | PromiseLike<undefined>): void;
  },
  complete: Promise<undefined>
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const blocked = Promise.withResolvers<IteratorResult<string>>();
      void complete.then(() => {
        blocked.resolve({ done: true, value: undefined });
      });
      let emitted = false;
      return {
        next: () => {
          if (!emitted) {
            emitted = true;
            return Promise.resolve({ done: false, value: line } as const);
          }
          return blocked.promise;
        },
        return: () => {
          returned.resolve(undefined);
          const done = { done: true, value: undefined } as const;
          blocked.resolve(done);
          return Promise.resolve(done);
        }
      };
    }
  };
}

function lineStreamWithBlockedReturn(
  lines: readonly string[],
  cleanupStarted: {
    resolve(value: undefined | PromiseLike<undefined>): void;
  },
  cleanup: Promise<undefined>,
  returned?: {
    resolve(value: undefined | PromiseLike<undefined>): void;
  }
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const blocked = Promise.withResolvers<IteratorResult<string>>();
      let index = 0;
      return {
        async next(): Promise<IteratorResult<string>> {
          if (index < lines.length) {
            const value = `${lines[index] ?? ""}\n`;
            index += 1;
            return { done: false, value };
          }
          return blocked.promise;
        },
        async return(): Promise<IteratorResult<string>> {
          cleanupStarted.resolve(undefined);
          blocked.resolve({ done: true, value: undefined });
          await cleanup;
          returned?.resolve(undefined);
          return { done: true, value: undefined };
        }
      };
    }
  };
}

async function drainEvents(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function firstLine(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  for await (const line of splitLines(stream)) {
    return line;
  }
  throw new Error("subprocess stdout ended before identity was emitted");
}

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function killProcess(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)}ms`);
    }
    await delay(10);
  }
}
