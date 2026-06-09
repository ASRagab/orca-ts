import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claude, codex, sessionId, z, type CodexProcess } from "../src/index.ts";

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

  test("maps backend config to codex args and prompt composition", async () => {
    let args: readonly string[] = [];
    const backend = codex({
      command: "codex-test",
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

    expect(args.slice(0, 8)).toEqual([
      "exec",
      "--json",
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

  test("returns explicit unsupported structured-output and resume paths", async () => {
    const structured = await claude()
      .autonomous({ prompt: "json", schema: z.object({ answer: z.string() }) })
      .awaitResult();
    expect(structured).toEqual({
      type: "failed",
      error: {
        _tag: "UnsupportedFeature",
        feature: "claude structured output",
        reason: "claude backend does not support live structured output"
      }
    });

    const resume = await claude()
      .autonomous({
        prompt: "continue",
        config: { resumeSessionId: sessionId("claude", "claude-prev") }
      })
      .awaitResult();
    expect(resume).toEqual({
      type: "failed",
      error: {
        _tag: "UnsupportedFeature",
        feature: "claude resume",
        reason: "claude backend does not support session resume"
      }
    });
  });

  test("routes interactive ask_user calls through the Orca MCP bridge", async () => {
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
              server: "orca",
              tool: "ask_user",
              arguments: { question: "Continue?" }
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
    expect(args).toContain("mcp_servers.orca.url=\"http://127.0.0.1:12345\"");
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
    let releaseStdout!: () => void;
    const stdoutBlocked = new Promise<void>((resolve) => {
      releaseStdout = resolve;
    });
    let closeBridge!: () => void;
    const closed = new Promise<void>((resolve) => {
      closeBridge = resolve;
    });
    const backend = codex({
      askUser: () => "yes",
      createAskUserServer: ({ responder }) => ({
        url: "http://127.0.0.1:12345",
        ask: async (request) => await responder(request),
        close: () => {
          closeBridge();
          return Promise.resolve();
        }
      }),
      spawnProcess: () => ({
        stdout: blockedStream(stdoutBlocked),
        stderr: lineStream([]),
        exit: stdoutBlocked.then(() => null),
        kill: () => {
          releaseStdout();
        }
      })
    });

    const conversation = backend.autonomous({ prompt: "run", config: { interactive: true } });
    await Promise.resolve();
    await conversation.cancel("stop");
    await closed;
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
