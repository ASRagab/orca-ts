import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  collectCodexJsonl,
  collectPiRpc,
  StreamConversation,
  codexExecJsonlArgs,
  piPromptCommand,
  piRpcArgs,
  sessionId
} from "../src/index.ts";

describe("Codex JSONL Tier 1 fixtures", () => {
  test("maps scripted JSONL streams to canonical events and outcomes", async () => {
    await assertJsonlFixtures("codex", async (lines) => await collectCodexJsonl(lines));
  });

  test("fails ask_user MCP bridge attempts explicitly", async () => {
    const actual = await collectCodexJsonl([
      '{"type":"thread.started","thread_id":"thr"}',
      '{"type":"item.started","item":{"id":"ask","type":"mcp_tool_call","server":"orcats","tool":"ask_user","arguments":{"question":"Continue?"}}}'
    ]);

    expect(actual.outcome).toEqual({
      type: "failed",
      error: {
        _tag: "UnsupportedFeature",
        feature: "codex ask_user",
        reason: "Codex ask_user MCP bridge requires an explicit interactive conversation"
      }
    });
  });

  test("builds codex exec JSONL args", () => {
    expect(codexExecJsonlArgs({ model: "gpt-5", approvalPolicy: "never", ignoreUserConfig: true })).toEqual([
      "exec",
      "--json",
      "--ignore-user-config",
      "--model",
      "gpt-5",
      "-c",
      "approval_policy=\"never\""
    ]);
  });

  test.each(["low", "medium", "high", "xhigh", "max", "ultra"] as const)(
    "forwards Codex reasoning effort %s without a local model catalog",
    (reasoningEffort) => {
      expect(codexExecJsonlArgs({ reasoningEffort })).toEqual([
        "exec",
        "--json",
        "-c",
        `model_reasoning_effort="${reasoningEffort}"`
      ]);
    }
  );

  test("documents the Codex reasoning-effort compatibility contract on both surfaces", async () => {
    const contract =
      "Orcats forwards all six declared values to Codex without a local model catalog. Actual acceptance depends on the selected model and Codex CLI version. Unsupported combinations return a backend failure.";

    for (const path of [
      "docs/backends.md",
      "website/src/content/docs/reference/backends.md"
    ]) {
      expect(await readFile(join(import.meta.dir, "..", path), "utf8")).toContain(contract);
    }
  });

  test("documents backend timeout outcomes without claiming signal abortion", async () => {
    const contract =
      "A backend timeout stops the transport and resolves `awaitResult()` to `{ type: \"failed\", error }`; it does not abort the conversation's `signal`. The signal aborts only when `cancel()` is requested.";
    const paths = [
      "docs/backends.md",
      "website/src/content/docs/reference/backends.md",
      "website/src/content/docs/reference/errors-and-results.md"
    ];

    for (const path of paths) {
      const contents = await readFile(join(import.meta.dir, "..", path), "utf8");
      expect(contents).toContain(contract);
      expect(contents).not.toContain("A timeout aborts the conversation's `signal`");
      expect(contents).not.toContain("Aborts when the run is cancelled or times out");
    }
  });

  test("documents successful and failed cancellation cleanup on both surfaces", async () => {
    const contract =
      "Successful cancellation resolves `cancel()` after the backend stops, then `awaitResult()` resolves to `{ type: \"cancelled\", reason }`. If cancellation cleanup fails, the shared `cancel()` promise rejects with the cleanup error and `awaitResult()` resolves to a typed `BackendFailed` outcome only after final cleanup and settlement release.";
    const incompleteClaim =
      "`cancel()` is cooperative: it signals the run and resolves once the backend has stopped. `awaitResult()` will subsequently resolve to `{ type: \"cancelled\", reason }`.";

    for (const path of [
      "docs/backends.md",
      "website/src/content/docs/reference/errors-and-results.md"
    ]) {
      const contents = await readFile(join(import.meta.dir, "..", path), "utf8");
      expect(contents).toContain(contract);
      expect(contents).not.toContain(incompleteClaim);
    }

    const website = await readFile(
      join(import.meta.dir, "..", "website/src/content/docs/reference/errors-and-results.md"),
      "utf8"
    );
    expect(website).toContain(
      "| `cancel(reason?)` | `(reason?: string) => Promise<void>` | Requests cancellation; resolves when cleanup succeeds and rejects if cleanup fails. |"
    );
    expect(website).not.toContain(
      "| `cancel(reason?)` | `(reason?: string) => Promise<void>` | Requests cancellation; resolves when the run has stopped. |"
    );
  });

  test("distinguishes Result operations from lifecycle promise rejections", async () => {
    const website = await readFile(
      join(import.meta.dir, "..", "website/src/content/docs/reference/errors-and-results.md"),
      "utf8"
    );
    expect(website).toContain(
      "Orca's result-returning operations represent expected failures as `Result` values rather than thrown exceptions. Asynchronous lifecycle methods keep promise semantics: public `cancel()` resolves after successful cleanup and rejects when cleanup fails."
    );
    expect(website).not.toContain("Every operation that can fail returns a `Result`");
  });

  test("builds read-only, schema, and resume args", () => {
    expect(
      codexExecJsonlArgs({
        readOnly: true,
        outputSchemaPath: "/tmp/schema.json",
        resumeSessionId: "codex-thread",
        prompt: "continue"
      })
    ).toEqual([
      "exec",
      "resume",
      "--json",
      "--output-schema",
      "/tmp/schema.json",
      // `codex exec resume` rejects `--sandbox`; sandbox is a config override here.
      "-c",
      "sandbox_mode=\"read-only\"",
      "codex-thread",
      "continue"
    ]);
  });

  test("plain exec keeps the exec-only --sandbox flag", () => {
    expect(codexExecJsonlArgs({ readOnly: true, prompt: "go" })).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "go"
    ]);
  });

  test("validates structured output from JSONL", async () => {
    const actual = await collectCodexJsonl(
      [
        "{\"type\":\"thread.started\",\"thread_id\":\"thr\"}",
        "{\"type\":\"item.completed\",\"item\":{\"id\":\"msg\",\"type\":\"agent_message\",\"text\":\"{\\\"answer\\\":\\\"yes\\\"}\"}}",
        "{\"type\":\"turn.completed\"}"
      ],
      { schema: z.object({ answer: z.string() }) }
    );

    expect(actual.outcome).toEqual({
      type: "success",
      result: {
        backend: "codex",
        sessionId: sessionId("codex", "thr"),
        output: "{\"answer\":\"yes\"}",
        structured: { answer: "yes" },
        usage: { input: 0, output: 0 }
      }
    });
  });

  test("uses last agent_message for structured output when codex emits progress blobs", async () => {
    // Codex emits one agent_message per step (progress updates then final answer).
    // Concatenating all steps produces invalid JSON; only the last message is the result.
    const actual = await collectCodexJsonl(
      [
        '{"type":"thread.started","thread_id":"thr"}',
        '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"{\\"answer\\":\\"thinking\\"}"}}',
        '{"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"{\\"answer\\":\\"done\\"}"}}',
        '{"type":"turn.completed"}'
      ],
      { schema: z.object({ answer: z.string() }) }
    );

    expect(actual.outcome).toEqual({
      type: "success",
      result: {
        backend: "codex",
        sessionId: sessionId("codex", "thr"),
        output: '{"answer":"thinking"}{"answer":"done"}',
        structured: { answer: "done" },
        usage: { input: 0, output: 0 }
      }
    });
  });

  test("fails invalid structured output with raw output", async () => {
    const actual = await collectCodexJsonl(
      [
        "{\"type\":\"thread.started\",\"thread_id\":\"thr\"}",
        "{\"type\":\"item.completed\",\"item\":{\"id\":\"msg\",\"type\":\"agent_message\",\"text\":\"{\\\"answer\\\":1}\"}}",
        "{\"type\":\"turn.completed\"}"
      ],
      { schema: z.object({ answer: z.string() }) }
    );

    expect(actual.outcome.type).toBe("failed");
    if (actual.outcome.type === "failed") {
      expect(actual.outcome.error._tag).toBe("StructuredOutputValidationFailed");
      if (actual.outcome.error._tag === "StructuredOutputValidationFailed") {
        expect(actual.outcome.error.raw).toEqual({ answer: 1 });
      }
    }
  });
});

describe("Pi RPC Tier 1 fixtures", () => {
  test("maps scripted RPC streams to canonical events and outcomes", async () => {
    await assertJsonlFixtures("pi", async (lines, dir) => {
      const session = JSON.parse(await readFile(join(dir, "session.json"), "utf8")) as {
        sessionId: string;
      };
      return await collectPiRpc(lines, session.sessionId);
    });
  });

  test("builds Pi RPC startup args and prompt command", () => {
    expect(piRpcArgs("/tmp/session")).toEqual(["--mode", "rpc", "--session-dir", "/tmp/session"]);
    expect(piPromptCommand("do it")).toBe(
      '{"id":"orca-prompt","type":"prompt","message":"do it"}'
    );
  });

  test("supports Pi cancellation through the shared conversation engine", async () => {
    const conversation = new StreamConversation({ backend: "pi" });
    await conversation.cancel("stop");
    expect(await conversation.awaitResult()).toEqual({ type: "cancelled", reason: "stop" });
  });
});

async function assertJsonlFixtures(
  backend: "codex" | "pi",
  collect: (
    lines: readonly string[],
    dir: string
  ) => Promise<{ readonly events: readonly unknown[]; readonly outcome: unknown }>
): Promise<void> {
  const root = join(process.cwd(), "fixtures", "tier1", backend);
  const cases = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  expect(cases.length).toBeGreaterThan(0);

  for (const name of cases) {
    const dir = join(root, name);
    const input = (await readFile(join(dir, "input.jsonl"), "utf8")).trim().split("\n");
    const expectedEvents = JSON.parse(await readFile(join(dir, "events.json"), "utf8")) as unknown;
    const expectedOutcome = JSON.parse(await readFile(join(dir, "outcome.json"), "utf8")) as unknown;
    const actual = await collect(input, dir);

    expect(actual.events as unknown).toEqual(expectedEvents);
    expect(actual.outcome).toEqual(expectedOutcome);
  }
}
