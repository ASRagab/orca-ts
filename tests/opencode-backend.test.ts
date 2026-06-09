import { describe, expect, test } from "bun:test";
import {
  opencode,
  sessionId,
  z,
  type OpenCodeHttp,
  type OpenCodeServerProcess
} from "../src/index.ts";

const TEXT_RUN: readonly string[] = [
  'data: {"type":"message.part.delta","properties":{"field":"text","delta":"done"}}',
  'data: {"type":"message.updated","properties":{"info":{"sessionID":"ses_live"}}}',
  'data: {"type":"session.idle"}'
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
      result: { backend: "opencode", sessionId: sessionId("opencode", "ses_live"), output: "done" }
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
          'data: {"type":"message.updated","properties":{"info":{"sessionID":"ses_s","structured":{"answer":"yes"}}}}',
          'data: {"type":"session.idle"}'
        ])
    });

    const outcome = await backend
      .autonomous({ prompt: "json", schema: z.object({ answer: z.string() }) })
      .awaitResult();

    expect(outcome).toEqual({
      type: "success",
      result: {
        backend: "opencode",
        sessionId: sessionId("opencode", "ses_s"),
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

function blockedHttp(): OpenCodeHttp {
  return {
    postJson(path) {
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
