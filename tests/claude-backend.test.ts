import { describe, expect, test } from "bun:test";
import { claude, sessionId, z, type ClaudeProcess } from "../src/index.ts";

describe("Claude live backend constructor", () => {
  test("starts claude stream-json and returns a branded result", async () => {
    let command = "";
    let args: readonly string[] = [];
    let stdin = "";
    const backend = claude({
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
    const backend = claude({
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
    const backend = claude({
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
    const backend = claude({
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
    const resumed = claude({
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

    const failing = claude({
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
    const backend = claude({
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

  test("cancels the child process", async () => {
    let killed = false;
    let releaseStdout!: () => void;
    const stdoutBlocked = new Promise<void>((resolve) => {
      releaseStdout = resolve;
    });
    const backend = claude({
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
