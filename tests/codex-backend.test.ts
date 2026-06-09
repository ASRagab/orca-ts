import { describe, expect, test } from "bun:test";
import { codex, type CodexProcess } from "../src/index.ts";

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
        sessionId: "codex-live",
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

  test("cancels the child process", async () => {
    let killed = false;
    let releaseStdout!: () => void;
    const stdoutBlocked = new Promise<void>((resolve) => {
      releaseStdout = resolve;
    });
    const backend = codex({
      spawnProcess: () => ({
        stdout: blockedStream(stdoutBlocked),
        stderr: lineStream([]),
        exit: stdoutBlocked.then(() => null),
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
