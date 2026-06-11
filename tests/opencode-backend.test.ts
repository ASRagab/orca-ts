import { describe, expect, test } from "bun:test";
import {
  collectOpenCodeSse,
  opencode,
  sessionId,
  z,
  type OpenCodeHttp,
  type OpenCodeServerProcess
} from "../src/index.ts";

const TEXT_RUN: readonly string[] = [
  'data: {"type":"message.part.delta","properties":{"sessionID":"ses_test","field":"text","delta":"done"}}',
  'data: {"type":"message.updated","properties":{"info":{"role":"assistant","sessionID":"ses_test"}}}',
  'data: {"type":"session.idle","properties":{"sessionID":"ses_test"}}'
];

describe("OpenCode live backend constructor", () => {
  test("drives the SSE stream and returns a branded result", async () => {
    const posts: Array<{ path: string; body: string }> = [];
    const backend = opencode({
      startServer: () => Promise.resolve(fakeServer()),
      connect: () => fakeHttp(TEXT_RUN, posts)
    });

    const conversation = backend.autonomous({ prompt: "do it", config: { model: "anthropic/claude-x" } });
    const outcome = await conversation.awaitResult();

    expect(posts[0]?.path).toBe("/session");
    expect(posts[1]?.path).toBe("/session/ses_test/prompt_async");
    const body = JSON.parse(posts[1]?.body ?? "{}") as Record<string, unknown>;
    expect(body.parts).toEqual([{ type: "text", text: "do it" }]);
    expect(body.model).toEqual({ providerID: "anthropic", modelID: "claude-x" });
    expect(body.tools).toEqual({ question: false });
    expect(outcome).toEqual({
      type: "success",
      result: { backend: "opencode", sessionId: sessionId("opencode", "ses_test"), output: "done" }
    });
  });

  test("closes the SSE stream after a successful turn", async () => {
    let captured: AbortSignal | undefined;
    const backend = opencode({
      startServer: () => Promise.resolve(fakeServer()),
      connect: () => {
        const http = fakeHttp(TEXT_RUN);
        return {
          postJson: http.postJson.bind(http),
          openEvents(signal) {
            captured = signal;
            return http.openEvents(signal);
          }
        };
      }
    });

    await backend.autonomous({ prompt: "do it" }).awaitResult();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captured?.aborted).toBe(true);
  });

  test("reuses one server across conversations and tears it down on shutdown", async () => {
    let starts = 0;
    const signals: string[] = [];
    const backend = opencode({
      startServer: () => {
        starts += 1;
        return Promise.resolve(fakeServer(signals));
      },
      connect: () => fakeHttp(TEXT_RUN)
    });

    await backend.autonomous({ prompt: "one" }).awaitResult();
    await backend.autonomous({ prompt: "two" }).awaitResult();
    expect(starts).toBe(1);

    await backend.shutdown();
    expect(signals).toEqual(["SIGINT"]);
  });

  test("returns a structured result from the SSE info payload", async () => {
    const backend = opencode({
      startServer: () => Promise.resolve(fakeServer()),
      connect: () =>
        fakeHttp([
          'data: {"type":"message.updated","properties":{"info":{"role":"assistant","sessionID":"ses_test","structured":{"answer":"yes"}}}}',
          'data: {"type":"session.idle","properties":{"sessionID":"ses_test"}}'
        ])
    });

    const outcome = await backend
      .autonomous({ prompt: "json", schema: z.object({ answer: z.string() }) })
      .awaitResult();

    expect(outcome).toEqual({
      type: "success",
      result: {
        backend: "opencode",
        sessionId: sessionId("opencode", "ses_test"),
        output: '{"answer":"yes"}',
        structured: { answer: "yes" }
      }
    });
  });

  test("cancels the SSE stream and keeps the shared server alive", async () => {
    const signals: string[] = [];
    const backend = opencode({
      startServer: () => Promise.resolve(fakeServer(signals)),
      connect: () => blockedHttp()
    });

    const conversation = backend.autonomous({ prompt: "run" });
    await Promise.resolve();
    await conversation.cancel("stop");

    expect(await conversation.awaitResult()).toEqual({ type: "cancelled", reason: "stop" });
    expect(signals).toEqual([]);
  });

  test("fails the turn when the event stream stalls past the inactivity timeout", async () => {
    const backend = opencode({
      startServer: () => Promise.resolve(fakeServer()),
      connect: () => stallingHttp(),
      inactivityTimeoutMs: 40
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "opencode",
        message: "opencode emitted no event for 40ms; treating the turn as stalled"
      }
    });
  });

  test("fails the turn when the wall-clock cap fires despite continuous activity", async () => {
    const backend = opencode({
      startServer: () => Promise.resolve(fakeServer()),
      connect: () => continuouslyActiveHttp(),
      inactivityTimeoutMs: 60_000,
      wallClockTimeoutMs: 50
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "opencode",
        message: "opencode turn exceeded 50ms wall-clock limit"
      }
    });
  });

  // Regression: the live hang. A result-only caller (`awaitResult()` without
  // iterating `events()`) must not deadlock once the agent emits more events
  // than the conversation queue holds — the queue evicts instead of blocking.
  test("completes a turn whose event volume exceeds the queue capacity when only the result is awaited", async () => {
    const flood = Array.from(
      { length: 600 },
      () =>
        'data: {"type":"message.part.delta","properties":{"sessionID":"ses_test","field":"text","delta":"x"}}'
    );
    const backend = opencode({
      startServer: () => Promise.resolve(fakeServer()),
      connect: () =>
        fakeHttp([
          ...flood,
          'data: {"type":"message.updated","properties":{"info":{"role":"assistant","sessionID":"ses_test"}}}',
          'data: {"type":"session.idle","properties":{"sessionID":"ses_test"}}'
        ])
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome).toEqual({
      type: "success",
      result: {
        backend: "opencode",
        sessionId: sessionId("opencode", "ses_test"),
        output: "x".repeat(600)
      }
    });
  });

  test("fails the turn when the server hangs before the event stream opens", async () => {
    const backend = opencode({
      startServer: () => Promise.resolve(fakeServer()),
      connect: () => ({
        postJson: () => Promise.resolve(""),
        openEvents: () =>
          new Promise<AsyncIterable<string>>(() => {
            // never resolves: the server accepts the request but sends nothing
          })
      }),
      wallClockTimeoutMs: 50
    });

    const outcome = await backend.autonomous({ prompt: "run" }).awaitResult();

    expect(outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "opencode",
        message: "opencode turn exceeded 50ms wall-clock limit"
      }
    });
  });

  test("reports failed startup as a backend failure", async () => {
    const backend = opencode({
      startServer: () => Promise.reject(new Error("serve missing"))
    });

    expect(await backend.autonomous({ prompt: "run" }).awaitResult()).toEqual({
      type: "failed",
      error: { _tag: "BackendFailed", backend: "opencode", message: "serve missing" }
    });
  });
});

describe("OpenCode driver parity with the Scala oracle", () => {
  function run(sse: readonly string[]): ReturnType<ReturnType<typeof opencode>["autonomous"]> {
    const backend = opencode({
      startServer: () => Promise.resolve(fakeServer()),
      connect: () => fakeHttp(sse)
    });
    return backend.autonomous({ prompt: "go" });
  }

  // Bug A: a subagent's idle must not steal the result.
  test("foreign-session session.idle does not settle the turn; own-session idle does", async () => {
    const outcome = await run([
      'data: {"type":"session.idle","properties":{"sessionID":"ses_other"}}',
      'data: {"type":"message.part.delta","properties":{"sessionID":"ses_test","field":"text","delta":"ok"}}',
      'data: {"type":"message.updated","properties":{"info":{"role":"assistant","sessionID":"ses_test"}}}',
      'data: {"type":"session.idle","properties":{"sessionID":"ses_test"}}'
    ]).awaitResult();

    expect(outcome).toEqual({
      type: "success",
      result: { backend: "opencode", sessionId: sessionId("opencode", "ses_test"), output: "ok" }
    });
  });

  // Oracle forall semantics: a protocol deviation must settle the turn, not hang it.
  test("terminal frame with no sessionID settles the turn", async () => {
    const outcome = await run([
      'data: {"type":"message.part.delta","properties":{"sessionID":"ses_test","field":"text","delta":"hi"}}',
      'data: {"type":"message.updated","properties":{"info":{"role":"assistant","sessionID":"ses_test"}}}',
      'data: {"type":"session.idle"}'
    ]).awaitResult();

    expect(outcome).toEqual({
      type: "success",
      result: { backend: "opencode", sessionId: sessionId("opencode", "ses_test"), output: "hi" }
    });
  });

  // Bug B: an empty user echo must not masquerade as — or wipe — the result.
  test("user-echo message.updated does not clobber structured output and usage", async () => {
    const outcome = await run([
      'data: {"type":"message.updated","properties":{"info":{"role":"assistant","sessionID":"ses_test","structured":{"answer":"yes"},"tokens":{"input":3,"output":2,"reasoning":0,"cache":{"read":1,"write":1}}}}}',
      'data: {"type":"message.updated","properties":{"info":{"role":"user","sessionID":"ses_test"}}}',
      'data: {"type":"session.idle","properties":{"sessionID":"ses_test"}}'
    ]).awaitResult();

    expect(outcome).toEqual({
      type: "success",
      result: {
        backend: "opencode",
        sessionId: sessionId("opencode", "ses_test"),
        output: '{"answer":"yes"}',
        structured: { answer: "yes" },
        usage: { input: 5, output: 2, reasoning: 0 }
      }
    });
  });

  // Bug C: agent errors ride info.error on the assistant message — they must
  // surface as failures, not as success with garbage output.
  test("session.idle after an assistant message carrying info.error fails the turn", async () => {
    const outcome = await run([
      'data: {"type":"message.updated","properties":{"info":{"role":"assistant","sessionID":"ses_test","error":{"name":"AgentError","data":{"message":"Failed with exit code 1"}}}}}',
      'data: {"type":"session.idle","properties":{"sessionID":"ses_test"}}'
    ]).awaitResult();

    expect(outcome).toEqual({
      type: "failed",
      error: { _tag: "BackendFailed", backend: "opencode", message: "Failed with exit code 1" }
    });
  });

  // Bug C: idle with nothing received is a failure, not an empty success.
  test("idle with no assistant message and no text fails", async () => {
    const outcome = await run([
      'data: {"type":"session.idle","properties":{"sessionID":"ses_test"}}'
    ]).awaitResult();

    expect(outcome).toEqual({
      type: "failed",
      error: {
        _tag: "BackendFailed",
        backend: "opencode",
        message: "session went idle without an assistant message"
      }
    });
  });

  // Bug D: the wrapped {name, data:{message}} envelope must yield the real message.
  test("session.error with a wrapped error envelope extracts the nested message", async () => {
    const outcome = await run([
      'data: {"type":"session.error","properties":{"sessionID":"ses_test","error":{"name":"ProviderError","data":{"message":"boom"}}}}'
    ]).awaitResult();

    expect(outcome).toEqual({
      type: "failed",
      error: { _tag: "BackendFailed", backend: "opencode", message: "boom" }
    });
  });

  // Bug E: failing tool calls must be visible in the event stream.
  test("tool part with status error surfaces as an error tool_result", async () => {
    const capture = await collectOpenCodeSse([
      'data: {"type":"message.part.updated","properties":{"part":{"id":"prt_1","type":"tool","tool":"bash","state":{"status":"running","input":{"cmd":"make"}}}}}',
      'data: {"type":"message.part.updated","properties":{"part":{"id":"prt_1","type":"tool","tool":"bash","state":{"status":"error","output":"tool exploded"}}}}',
      'data: {"type":"message.updated","properties":{"info":{"role":"assistant","sessionID":"ses_test"}}}',
      'data: {"type":"session.idle"}'
    ]);

    expect(capture.events).toContainEqual({
      type: "assistant_tool_call",
      id: "prt_1",
      name: "bash",
      input: { cmd: "make" }
    });
    expect(capture.events).toContainEqual({
      type: "tool_result",
      toolCallId: "prt_1",
      output: "tool exploded",
      isError: true
    });
  });

  // Bug F: a cancelled turn must stop editing on the shared server.
  test("abort mid-turn posts /session/{id}/abort", async () => {
    const posts: Array<{ path: string; body: string }> = [];
    const backend = opencode({
      startServer: () => Promise.resolve(fakeServer()),
      connect: () => blockedHttp(posts)
    });

    const conversation = backend.autonomous({ prompt: "run" });
    // Wait until the turn has started (prompt_async posted) so the abort
    // listener is registered before we cancel.
    while (!posts.some((post) => post.path.endsWith("/prompt_async"))) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await conversation.cancel("stop");

    expect(await conversation.awaitResult()).toEqual({ type: "cancelled", reason: "stop" });
    expect(posts.map((post) => post.path)).toContain("/session/ses_test/abort");
  });
});

function fakeServer(signals: string[] = []): OpenCodeServerProcess {
  return {
    url: "http://127.0.0.1:0",
    stop(signal) {
      signals.push(signal ?? "");
      return Promise.resolve();
    }
  };
}

function fakeHttp(sse: readonly string[], posts: Array<{ path: string; body: string }> = []): OpenCodeHttp {
  return {
    postJson(path, body) {
      posts.push({ path, body });
      if (path === "/session") {
        return Promise.resolve(JSON.stringify({ id: "ses_test" }));
      }
      return Promise.resolve("");
    },
    openEvents() {
      return Promise.resolve(lineStream(sse));
    }
  };
}

/** Yields two non-terminal events, then never produces another — models
 * opencode 1.16.2 going silent (no `session.idle`, no heartbeat) mid-turn. */
function stallingHttp(): OpenCodeHttp {
  return {
    postJson(path) {
      if (path === "/session") {
        return Promise.resolve(JSON.stringify({ id: "ses_test" }));
      }
      return Promise.resolve("");
    },
    openEvents() {
      return Promise.resolve(
        (async function* (): AsyncIterable<string> {
          yield 'data: {"type":"message.part.delta","properties":{"field":"text","delta":"working"}}';
          yield 'data: {"type":"message.updated","properties":{"info":{"sessionID":"ses_x"}}}';
          await new Promise<void>(() => {
            // never resolves: the stream stalls with no further events
          });
        })()
      );
    }
  };
}

function continuouslyActiveHttp(): OpenCodeHttp {
  return {
    postJson(path) {
      if (path === "/session") {
        return Promise.resolve(JSON.stringify({ id: "ses_test" }));
      }
      return Promise.resolve("");
    },
    openEvents() {
      return Promise.resolve(
        (async function* (): AsyncIterable<string> {
          for (;;) {
            yield 'data: {"type":"message.part.delta","properties":{"sessionID":"ses_test","field":"text","delta":"x"}}';
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          }
        })()
      );
    }
  };
}

function blockedHttp(posts: Array<{ path: string; body: string }> = []): OpenCodeHttp {
  return {
    postJson(path, body) {
      posts.push({ path, body });
      if (path === "/session") {
        return Promise.resolve(JSON.stringify({ id: "ses_test" }));
      }
      return Promise.resolve("");
    },
    openEvents(signal) {
      return Promise.resolve(
        (async function* (): AsyncIterable<string> {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true }
            );
          });
          yield* [];
        })()
      );
    }
  };
}

async function* lineStream(lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) {
    await Promise.resolve();
    yield line;
  }
}
