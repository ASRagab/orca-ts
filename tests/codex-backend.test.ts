import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { codex, sessionId, z, type CodexProcess } from "../src/index.ts";
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

async function* neverStream(): AsyncIterable<string> {
  const gate = Promise.withResolvers<undefined>();
  await gate.promise;
  yield* [];
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

async function drainEvents(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
