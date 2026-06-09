import { describe, expect, test } from "bun:test";
import { pi, sessionId, z, type PiProcess } from "../src/index.ts";

describe("Pi live backend constructor", () => {
  test("starts pi rpc, emits ordered events, and returns a branded result", async () => {
    let command = "";
    let args: readonly string[] = [];
    let stdin = "";
    const backend = pi({
      command: "pi-test",
      config: { model: "pi-large" },
      spawnProcess: (actualCommand, actualArgs) => {
        command = actualCommand;
        args = actualArgs;
        return fakeProcess(
          [
            { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a" } },
            {
              type: "tool_execution_end",
              toolCallId: "t1",
              result: { content: [{ type: "text", text: "ok" }] }
            },
            { type: "message_end", message: { content: [{ type: "text", text: "done" }] } },
            { type: "agent_end" }
          ],
          { onWrite: (data) => (stdin += data) }
        );
      }
    });

    const conversation = backend.autonomous({
      prompt: "go",
      config: { resumeSessionId: sessionId("pi", "pi-known") }
    });
    const events = drainEvents(conversation.events());
    const outcome = await conversation.awaitResult();

    expect(command).toBe("pi-test");
    expect(args.slice(0, 3)).toEqual(["--mode", "rpc", "--session-dir"]);
    expect(args).toContain("--continue");
    expect(args).toContain("--model");
    expect(JSON.parse(stdin.trim())).toEqual({ id: "orca-prompt", type: "prompt", message: "go" });
    expect(await events).toEqual([
      { type: "assistant_tool_call", id: "t1", name: "read", input: { path: "a" } },
      { type: "tool_result", toolCallId: "t1", output: "ok", isError: false },
      { type: "assistant_text_delta", text: "done" },
      { type: "assistant_turn_end" }
    ]);
    expect(outcome).toEqual({
      type: "success",
      result: {
        backend: "pi",
        sessionId: sessionId("pi", "pi-known"),
        output: "done",
        usage: { input: 0, output: 0 }
      }
    });
  });

  test("gates tools to the read-only allow-list when readOnly is set", async () => {
    let args: readonly string[] = [];
    const backend = pi({
      config: { readOnly: true },
      spawnProcess: (_command, actualArgs) => {
        args = actualArgs;
        return fakeProcess([{ type: "agent_end" }]);
      }
    });

    await backend.autonomous({ prompt: "look" }).awaitResult();

    const toolsIndex = args.indexOf("--tools");
    expect(toolsIndex).toBeGreaterThan(-1);
    expect(args[toolsIndex + 1]).toBe("read,grep,find,ls");
  });

  test("omits the tools gate when not read-only", async () => {
    let args: readonly string[] = [];
    const backend = pi({
      spawnProcess: (_command, actualArgs) => {
        args = actualArgs;
        return fakeProcess([{ type: "agent_end" }]);
      }
    });
    await backend.autonomous({ prompt: "go" }).awaitResult();
    expect(args).not.toContain("--tools");
  });

  test("validates structured output against the schema", async () => {
    const ok = pi({
      spawnProcess: () =>
        fakeProcess([
          { type: "message_end", message: { content: [{ type: "text", text: '{"answer":"yes"}' }] } },
          { type: "agent_end" }
        ])
    });
    const okOutcome = await ok
      .autonomous({
        prompt: "json",
        schema: z.object({ answer: z.string() }),
        config: { resumeSessionId: sessionId("pi", "pi-s") }
      })
      .awaitResult();
    expect(okOutcome.type).toBe("success");
    if (okOutcome.type === "success") {
      expect(okOutcome.result.structured).toEqual({ answer: "yes" });
    }

    const bad = pi({
      spawnProcess: () =>
        fakeProcess([
          { type: "message_end", message: { content: [{ type: "text", text: "not json" }] } },
          { type: "agent_end" }
        ])
    });
    const badOutcome = await bad
      .autonomous({ prompt: "json", schema: z.object({ answer: z.string() }) })
      .awaitResult();
    expect(badOutcome.type).toBe("failed");
    if (badOutcome.type === "failed") {
      expect(badOutcome.error._tag).toBe("StructuredOutputValidationFailed");
    }
  });

  test("fails when the stream ends before agent_end", async () => {
    const backend = pi({
      spawnProcess: () =>
        fakeProcess([{ type: "message_end", message: { content: [{ type: "text", text: "partial" }] } }])
    });
    expect(await backend.autonomous({ prompt: "run" }).awaitResult()).toEqual({
      type: "failed",
      error: { _tag: "BackendFailed", backend: "pi", message: "pi stream ended before agent_end" }
    });
  });

  test("reports startup failures as backend failures", async () => {
    const backend = pi({
      spawnProcess: () => {
        throw new Error("pi missing");
      }
    });
    expect(await backend.autonomous({ prompt: "run" }).awaitResult()).toEqual({
      type: "failed",
      error: { _tag: "BackendFailed", backend: "pi", message: "pi missing" }
    });
  });

  test("cancels the child process", async () => {
    let killed = false;
    let releaseStdout!: () => void;
    const stdoutBlocked = new Promise<void>((resolve) => {
      releaseStdout = resolve;
    });
    const backend = pi({
      spawnProcess: () => ({
        stdout: blockedStream(stdoutBlocked),
        stderr: lineStream([]),
        exit: stdoutBlocked.then(() => null),
        write: () => {},
        endStdin: () => {},
        kill: () => {
          killed = true;
          releaseStdout();
        }
      })
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await Promise.resolve();
    await conversation.cancel("stop");

    expect(killed).toBe(true);
    expect(await conversation.awaitResult()).toEqual({ type: "cancelled", reason: "stop" });
  });
});

type JsonLine = string | Record<string, unknown>;

function fakeProcess(
  stdout: readonly JsonLine[],
  options: { readonly exitCode?: number | null; readonly onWrite?: (data: string) => void } = {}
): PiProcess {
  return {
    stdout: lineStream(stdout.map((line) => (typeof line === "string" ? line : JSON.stringify(line)))),
    stderr: lineStream([]),
    exit: Promise.resolve(options.exitCode ?? 0),
    write: (data) => options.onWrite?.(data),
    endStdin: () => {},
    kill: () => {}
  };
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
