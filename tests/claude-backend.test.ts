import { describe, expect, test } from "bun:test";
import {
  claude,
  sessionId,
  z,
  type ClaudeBackendOptions,
  type ClaudeProcess
} from "../src/index.ts";
import { type AcpId, type AcpProcess, type AcpRequestMessage } from "../src/backends/acp-client.ts";

describe("Claude live backend constructor", () => {
  test("defaults to Claude ACP and returns a branded result", async () => {
    let command = "";
    let args: readonly string[] = [];
    let writes: Record<string, unknown>[] = [];
    const backend = claude({
      cwd: "/tmp/orca-acp",
      config: { systemPrompt: "Prefer short answers." },
      spawnAcpProcess: (actualCommand, actualArgs) => {
        command = actualCommand;
        args = actualArgs;
        const process = fakeAcpProcess((message, push) => {
          if (message.method === "initialize") {
            push(response(message.id, { protocolVersion: 1, agentCapabilities: {} }));
          }
          if (message.method === "session/new") {
            push(response(message.id, {
              sessionId: "claude-acp-live",
              configOptions: [
                {
                  id: "mode",
                  options: [{ value: "plan" }, { value: "bypassPermissions" }]
                }
              ]
            }));
          }
          if (message.method === "session/set_config_option") {
            push(response(message.id, { configOptions: [] }));
          }
          if (message.method === "session/prompt") {
            push({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "claude-acp-live",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "done" }
                }
              }
            });
            push(response(message.id, { stopReason: "end_turn" }));
          }
        });
        writes = process.writes;
        return process;
      }
    });

    const conversation = backend.autonomous({ prompt: "inspect the repo" });
    const events = drainEvents(conversation.events());
    const outcome = await conversation.awaitResult();

    expect(command).toBe("claude-agent-acp");
    expect(args).toEqual([]);
    expect(writes[0]?.method).toBe("initialize");
    expect(writes[1]).toMatchObject({ method: "session/new", params: { cwd: "/tmp/orca-acp" } });
    expect(writes[2]).toMatchObject({
      method: "session/set_config_option",
      params: { sessionId: "claude-acp-live", configId: "mode", value: "bypassPermissions" }
    });
    expect(JSON.stringify(writes[3]?.params)).toContain("Prefer short answers.");
    expect(await events).toEqual([
      { type: "assistant_text_delta", text: "done" },
      { type: "assistant_turn_end" }
    ]);
    expect(outcome).toEqual({
      type: "success",
      result: { backend: "claude", sessionId: sessionId("claude", "claude-acp-live"), output: "done" }
    });
  });

  test("routes Claude model overrides through stream-json fallback", async () => {
    let command = "";
    let args: readonly string[] = [];
    const backend = claude({
      command: "claude-test",
      config: { model: "claude-opus-4-8" },
      spawnAcpProcess: () => {
        throw new Error("ACP should not start for model-pinned Claude runs");
      },
      spawnProcess: (actualCommand, actualArgs) => {
        command = actualCommand;
        args = actualArgs;
        return fakeProcess([
          { type: "result", subtype: "success", session_id: "claude-model", result: "done" }
        ]);
      }
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(command).toBe("claude-test");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    expect(outcome.type).toBe("success");
  });

  test("validates Claude ACP structured output", async () => {
    let promptPayload = "";
    const backend = claude({
      spawnAcpProcess: () =>
        fakeAcpProcess((message, push) => {
          if (message.method === "initialize") {
            push(response(message.id, { protocolVersion: 1, agentCapabilities: {} }));
          }
          if (message.method === "session/new") {
            push(response(message.id, { sessionId: "claude-acp-structured" }));
          }
          if (message.method === "session/prompt") {
            promptPayload = JSON.stringify(message.params);
            push({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "claude-acp-structured",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "{\"answer\":\"yes\"}" }
                }
              }
            });
            push(response(message.id, { stopReason: "end_turn" }));
          }
        })
    });

    const outcome = await backend
      .autonomous({ prompt: "answer as JSON", schema: z.object({ answer: z.string() }) })
      .awaitResult();

    expect(outcome).toEqual({
      type: "success",
      result: {
        backend: "claude",
        sessionId: sessionId("claude", "claude-acp-structured"),
        output: "{\"answer\":\"yes\"}",
        structured: { answer: "yes" }
      }
    });
    expect(promptPayload).toContain("JSON Schema");
    expect(promptPayload).toContain("answer");
  });

  test("validates Claude ACP structured output from backend config", async () => {
    const backend = claude({
      config: { structuredOutput: { schema: z.object({ answer: z.string() }) } },
      spawnAcpProcess: () => fakeSuccessfulAcpProcess("claude-acp-config-structured", "Note:\n{\"answer\":\"yes\"}")
    });

    const outcome = await backend.autonomous({ prompt: "answer as JSON" }).awaitResult();

    expect(outcome).toEqual({
      type: "success",
      result: {
        backend: "claude",
        sessionId: sessionId("claude", "claude-acp-config-structured"),
        output: "Note:\n{\"answer\":\"yes\"}",
        structured: { answer: "yes" }
      }
    });
  });

  test("reports Claude ACP structured output validation failures", async () => {
    const invalidJson = claude({
      spawnAcpProcess: () => fakeSuccessfulAcpProcess("claude-acp-invalid-json", "not json")
    });
    const schemaMismatch = claude({
      spawnAcpProcess: () => fakeSuccessfulAcpProcess("claude-acp-schema-mismatch", "{\"answer\":42}")
    });

    const invalidJsonOutcome = await invalidJson
      .autonomous({ prompt: "answer as JSON", schema: z.object({ answer: z.string() }) })
      .awaitResult();
    const mismatchOutcome = await schemaMismatch
      .autonomous({ prompt: "answer as JSON", schema: z.object({ answer: z.string() }) })
      .awaitResult();

    expect(invalidJsonOutcome.type).toBe("failed");
    if (invalidJsonOutcome.type === "failed") {
      expect(invalidJsonOutcome.error._tag).toBe("StructuredOutputValidationFailed");
    }
    expect(mismatchOutcome.type).toBe("failed");
    if (mismatchOutcome.type === "failed") {
      expect(mismatchOutcome.error._tag).toBe("StructuredOutputValidationFailed");
    }
  });

  test("brands Claude ACP phase failures", async () => {
    const cases: readonly [string, string, (message: AcpRequestMessage) => boolean][] = [
      ["initialization", "initialize", (message) => message.method === "initialize"],
      ["session creation", "session/new", (message) => message.method === "session/new"],
      ["prompt execution", "session/prompt", (message) => message.method === "session/prompt"]
    ];

    for (const [phase, failedMethod, shouldFail] of cases) {
      const backend = claude({
        spawnAcpProcess: () =>
          fakeAcpProcess((message, push) => {
            if (shouldFail(message)) {
              push({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `${failedMethod} broke` } });
              return;
            }
            if (message.method === "initialize") {
              push(response(message.id, { protocolVersion: 1, agentCapabilities: {} }));
            }
            if (message.method === "session/new") {
              push(response(message.id, { sessionId: "claude-acp-phase" }));
            }
          })
      });

      const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

      expect(outcome).toEqual({
        type: "failed",
        error: {
          _tag: "BackendFailed",
          backend: "claude",
          message: `Claude ACP ${phase} failed: ${failedMethod} broke (-32000)`
        }
      });
    }
  });

  test("brands Claude ACP setup failures", async () => {
    const backend = claude({
      spawnAcpProcess: () => {
        throw new Error("missing acp adapter");
      }
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "claude",
        message: "Claude ACP initialization failed: missing acp adapter"
      }
    });
  });

  test("brands Claude ACP shutdown failures", async () => {
    const backend = claude({
      spawnAcpProcess: () =>
        fakeAcpProcess((message, push, pushRaw) => {
          if (message.method === "initialize") {
            push(response(message.id, { protocolVersion: 1, agentCapabilities: {} }));
          }
          if (message.method === "session/new") {
            push(response(message.id, { sessionId: "claude-acp-shutdown" }));
          }
          if (message.method === "session/prompt") {
            push(response(message.id, { stopReason: "end_turn" }));
            pushRaw("not json");
          }
        })
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome.type).toBe("failed");
    if (outcome.type === "failed") {
      expect(outcome.error).toMatchObject({
        _tag: "BackendFailed",
        backend: "claude"
      });
      if (outcome.error._tag === "BackendFailed") {
        expect(outcome.error.message).toContain("Claude ACP shutdown failed: invalid ACP JSON-RPC message");
      }
    }
  });

  test("rejects Claude ACP writes in read-only mode and blocks paths outside cwd", async () => {
    let writes: Record<string, unknown>[] = [];
    const cwd = process.cwd();
    const backend = claude({
      cwd,
      config: { readOnly: true },
      spawnAcpProcess: () => {
        const process = fakeAcpProcess((message, push) => {
          if (message.method === "initialize") {
            push(response(message.id, { protocolVersion: 1, agentCapabilities: {} }));
          }
          if (message.method === "session/new") {
            push(response(message.id, { sessionId: "claude-acp-fs" }));
          }
          if (message.method === "session/prompt") {
            push({
              jsonrpc: "2.0",
              id: 99,
              method: "fs/write_text_file",
              params: { path: "package.json", content: "{}" }
            });
            push({
              jsonrpc: "2.0",
              id: 100,
              method: "fs/read_text_file",
              params: { path: "/etc/hosts" }
            });
            push(response(message.id, { stopReason: "end_turn" }));
          }
        });
        writes = process.writes;
        return process;
      }
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome.type).toBe("success");
    expect(writes).toContainEqual({
      jsonrpc: "2.0",
      id: 99,
      error: { code: -32000, message: "write request rejected in read-only mode" }
    });
    expect(writes).toContainEqual({
      jsonrpc: "2.0",
      id: 100,
      error: { code: -32000, message: "path outside backend cwd" }
    });
  });

  test("fails Claude ACP prompts with non-terminal stop reasons", async () => {
    const backend = claude({
      spawnAcpProcess: () =>
        fakeAcpProcess((message, push) => {
          if (message.method === "initialize") {
            push(response(message.id, { protocolVersion: 1, agentCapabilities: {} }));
          }
          if (message.method === "session/new") {
            push(response(message.id, { sessionId: "claude-acp-max-tokens" }));
          }
          if (message.method === "session/prompt") {
            push(response(message.id, { stopReason: "max_tokens" }));
          }
        })
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "claude",
        message: "Claude ACP prompt stopped with max_tokens"
      }
    });
  });

  test("sends Claude ACP cancellation and force-closes on timeout", async () => {
    let process: FakeAcpProcess | undefined;
    const backend = claude({
      acpCancelTimeoutMs: 5,
      spawnAcpProcess: () => {
        process = fakeAcpProcess((message, push) => {
          if (message.method === "initialize") {
            push(response(message.id, { protocolVersion: 1, agentCapabilities: {} }));
          }
          if (message.method === "session/new") {
            push(response(message.id, { sessionId: "claude-acp-cancel" }));
          }
        });
        return process;
      }
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await waitFor(() => process !== undefined && process.writes.some((message) => message.method === "session/prompt"));
    await conversation.cancel("stop");

    expect(process?.writes).toContainEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "claude-acp-cancel" }
    });
    expect(process?.signals).toContain("SIGKILL");
    expect(await conversation.awaitResult()).toEqual({ type: "cancelled", reason: "stop" });
  });

  test("rejects Claude ACP cancellation failures after settling a typed outcome", async () => {
    let process: FakeAcpProcess | undefined;
    let promptId: AcpId | undefined;
    const backend = claude({
      acpCancelTimeoutMs: 1,
      spawnAcpProcess: () => {
        process = fakeAcpProcess((message, push) => {
          if (message.method === "initialize") {
            push(response(message.id, { protocolVersion: 1, agentCapabilities: {} }));
          }
          if (message.method === "session/new") {
            push(response(message.id, { sessionId: "claude-acp-cancel-failure" }));
          }
          if (message.method === "session/prompt") {
            promptId = message.id;
          }
        });
        const write = process.write.bind(process);
        process.write = (data) => {
          const message = JSON.parse(data.trim()) as Record<string, unknown>;
          if (message.method === "session/cancel") {
            throw new Error("process refused cancellation");
          }
          write(data);
        };
        return process;
      }
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await waitFor(() => process !== undefined && promptId !== undefined);
    let outcomeBeforeRejection: unknown;
    void conversation.awaitResult().then((outcome) => {
      outcomeBeforeRejection = outcome;
    });
    const cancellationError = await conversation.cancel("stop").then(
      () => undefined,
      (error: unknown) => error
    );

    expect(cancellationError).toBeInstanceOf(Error);
    expect((cancellationError as Error).message).toBe(
      "Claude ACP cancellation failed: process refused cancellation"
    );
    expect(outcomeBeforeRejection).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "claude",
        message:
          "claude cancellation cleanup failed: Claude ACP cancellation failed: process refused cancellation"
      }
    });
    process?.close(null);
  });

  test("fails and force-closes a silent Claude ACP prompt on inactivity timeout", async () => {
    let process: FakeAcpProcess | undefined;
    const backend = claude({
      inactivityTimeoutMs: 5,
      wallClockTimeoutMs: 1_000,
      spawnAcpProcess: () => {
        process = fakeAcpProcess((message, push) => {
          if (message.method === "initialize") {
            push(response(message.id, { protocolVersion: 1, agentCapabilities: {} }));
          }
          if (message.method === "session/new") {
            push(response(message.id, { sessionId: "claude-acp-silent" }));
          }
        });
        return process;
      }
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(process?.signals).toContain("SIGKILL");
    expect(outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "claude",
        message: "Claude ACP prompt execution failed: emitted no session updates for 5ms"
      }
    });
  });

  test("does not spawn Claude ACP after immediate cancellation", async () => {
    let spawned = false;
    const backend = claude({
      spawnAcpProcess: () => {
        spawned = true;
        return fakeSuccessfulAcpProcess("claude-acp-late", "done");
      }
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await conversation.cancel("stop");
    await Promise.resolve();

    expect(spawned).toBe(false);
    expect(await conversation.awaitResult()).toEqual({ type: "cancelled", reason: "stop" });
  });

  test("starts claude stream-json fallback and returns a branded result", async () => {
    let command = "";
    let args: readonly string[] = [];
    let stdin = "";
    const backend = claudeStreamJson({
      command: "claude-test",
      config: { model: "claude-opus-4-8" },
      spawnProcess: (actualCommand, actualArgs) => {
        command = actualCommand;
        args = actualArgs;
        return fakeProcess(
          [
            { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
            { type: "result", subtype: "success", session_id: "claude-live", result: "done" }
          ],
          { onWrite: (data) => (stdin += data) }
        );
      }
    });

    const conversation = backend.autonomous({ prompt: "inspect the repo" });
    const events = drainEvents(conversation.events());
    const outcome = await conversation.awaitResult();

    expect(command).toBe("claude-test");
    expect(args).toEqual([
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      "claude-opus-4-8",
      "--permission-mode",
      "bypassPermissions"
    ]);
    expect(JSON.parse(stdin.trim())).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "inspect the repo" }] }
    });
    expect(await events).toEqual([
      { type: "assistant_text_delta", text: "done" },
      { type: "assistant_turn_end" }
    ]);
    expect(outcome).toEqual({
      type: "success",
      result: { backend: "claude", sessionId: sessionId("claude", "claude-live"), output: "done" }
    });
  });

  test("passes the json schema and returns structured values", async () => {
    let args: readonly string[] = [];
    const backend = claudeStreamJson({
      spawnProcess: (_command, actualArgs) => {
        args = actualArgs;
        return fakeProcess([
          {
            type: "result",
            subtype: "success",
            session_id: "claude-structured",
            result: "{\"answer\":\"yes\"}"
          }
        ]);
      }
    });

    const outcome = await backend
      .autonomous({ prompt: "answer as JSON", schema: z.object({ answer: z.string() }) })
      .awaitResult();

    const schemaIndex = args.indexOf("--json-schema");
    expect(schemaIndex).toBeGreaterThan(-1);
    expect(args[schemaIndex + 1]).toContain("\"answer\"");
    expect(outcome).toEqual({
      type: "success",
      result: {
        backend: "claude",
        sessionId: sessionId("claude", "claude-structured"),
        output: "{\"answer\":\"yes\"}",
        structured: { answer: "yes" }
      }
    });
  });

  test("prefers the structured_output field over result", async () => {
    const backend = claudeStreamJson({
      spawnProcess: () =>
        fakeProcess([
          {
            type: "result",
            subtype: "success",
            session_id: "claude-sf",
            result: "ignored prose",
            structured_output: { answer: "yes" }
          }
        ])
    });

    const outcome = await backend
      .autonomous({ prompt: "json", schema: z.object({ answer: z.string() }) })
      .awaitResult();

    expect(outcome).toEqual({
      type: "success",
      result: {
        backend: "claude",
        sessionId: sessionId("claude", "claude-sf"),
        output: '{"answer":"yes"}',
        structured: { answer: "yes" }
      }
    });
  });

  test("returns a typed validation error on schema mismatch", async () => {
    const backend = claudeStreamJson({
      spawnProcess: () =>
        fakeProcess([
          {
            type: "result",
            subtype: "success",
            session_id: "claude-bad",
            result: "{\"answer\":42}"
          }
        ])
    });

    const outcome = await backend
      .autonomous({ prompt: "json", schema: z.object({ answer: z.string() }) })
      .awaitResult();

    expect(outcome.type).toBe("failed");
    if (outcome.type === "failed") {
      expect(outcome.error._tag).toBe("StructuredOutputValidationFailed");
    }
  });

  test("resumes with --resume and reports startup failures", async () => {
    let args: readonly string[] = [];
    const resumed = claudeStreamJson({
      spawnProcess: (_command, actualArgs) => {
        args = actualArgs;
        return fakeProcess([
          { type: "result", subtype: "success", session_id: "claude-next", result: "next" }
        ]);
      }
    });
    await resumed
      .autonomous({ prompt: "continue", config: { resumeSessionId: sessionId("claude", "claude-prev") } })
      .awaitResult();
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("claude-prev");

    const failing = claudeStreamJson({
      spawnProcess: () => {
        throw new Error("claude missing");
      }
    });
    expect(await failing.autonomous({ prompt: "run" }).awaitResult()).toEqual({
      type: "failed",
      error: { _tag: "BackendFailed", backend: "claude", message: "claude missing" }
    });
  });

  test("fails when the stream ends before a result message", async () => {
    const backend = claudeStreamJson({
      spawnProcess: () =>
        fakeProcess([
          { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }
        ])
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();
    expect(outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "claude",
        message: "claude exited cleanly but never sent a result message"
      }
    });
  });

  test("waits for the stream-json child to exit during cancellation", async () => {
    const spawned = Promise.withResolvers<undefined>();
    const exit = Promise.withResolvers<number | null>();
    const signals: NodeJS.Signals[] = [];
    const backend = claudeStreamJson({
      spawnProcess: () => {
        spawned.resolve(undefined);
        return {
          stdout: blockedStream(exit.promise.then(() => undefined)),
          stderr: lineStream([]),
          exit: exit.promise,
          write: () => {},
          endStdin: () => {},
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

    expect(beforeExit).toBe("pending");
    expect(signals).toEqual(["SIGTERM"]);
    expect(await conversation.awaitResult()).toEqual({ type: "cancelled", reason: "stop" });
  });
});

function claudeStreamJson(options: ClaudeBackendOptions = {}) {
  return claude({ ...options, transport: "stream-json" });
}

type JsonLine = string | Record<string, unknown>;

function fakeProcess(
  stdout: readonly JsonLine[],
  options: {
    readonly exitCode?: number | null;
    readonly stderr?: readonly string[];
    readonly onWrite?: (data: string) => void;
  } = {}
): ClaudeProcess {
  return {
    stdout: lineStream(stdout.map((line) => (typeof line === "string" ? line : JSON.stringify(line)))),
    stderr: lineStream(options.stderr ?? []),
    exit: Promise.resolve(options.exitCode ?? 0),
    write: (data) => options.onWrite?.(data),
    endStdin: () => {},
    kill: () => {}
  };
}

interface FakeAcpProcess extends AcpProcess {
  readonly writes: Record<string, unknown>[];
  readonly signals: NodeJS.Signals[];
  killed: boolean;
  push(message: Record<string, unknown>): void;
  pushRaw(line: string): void;
  close(exitCode?: number | null): void;
}

function fakeSuccessfulAcpProcess(session: string, output: string): FakeAcpProcess {
  return fakeAcpProcess((message, push) => {
    if (message.method === "initialize") {
      push(response(message.id, { protocolVersion: 1, agentCapabilities: {} }));
    }
    if (message.method === "session/new") {
      push(response(message.id, { sessionId: session }));
    }
    if (message.method === "session/prompt") {
      push({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: session,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: output }
          }
        }
      });
      push(response(message.id, { stopReason: "end_turn" }));
    }
  });
}

function fakeAcpProcess(
  onMessage: (
    message: AcpRequestMessage,
    push: (message: Record<string, unknown>) => void,
    pushRaw: (line: string) => void
  ) => void
): FakeAcpProcess {
  const writes: Record<string, unknown>[] = [];
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const exit = Promise.withResolvers<number | null>();
  const process: FakeAcpProcess = {
    writes,
    signals: [],
    killed: false,
    stdout: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const line = lines.shift();
          if (line !== undefined) {
            yield `${line}\n`;
            continue;
          }
          if (closed) {
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }
    },
    stderr: lineStream([]),
    exit: exit.promise,
    write(data: string) {
      const parsed = JSON.parse(data.trim()) as Record<string, unknown>;
      writes.push(parsed);
      if ("id" in parsed && typeof parsed.method === "string") {
        onMessage(
          parsed as unknown as AcpRequestMessage,
          (message) => {
            process.push(message);
          },
          (line) => {
            process.pushRaw(line);
          }
        );
      }
    },
    endStdin() {},
    kill(signal = "SIGTERM") {
      process.signals.push(signal);
      process.killed = true;
      process.close(null);
    },
    push(message: Record<string, unknown>) {
      lines.push(JSON.stringify(message));
      wake?.();
      wake = undefined;
    },
    pushRaw(line: string) {
      lines.push(line);
      wake?.();
      wake = undefined;
    },
    close(exitCode: number | null = 0) {
      closed = true;
      wake?.();
      wake = undefined;
      exit.resolve(exitCode);
    }
  };
  return process;
}

function response(id: AcpId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

async function* lineStream(lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) {
    await Promise.resolve();
    yield `${line}\n`;
  }
}

async function* blockedStream(blocked: Promise<void>): AsyncIterable<string> {
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(1);
  }
  throw new Error("condition not met");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
