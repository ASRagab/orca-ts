import { spawn } from "node:child_process";
import type { z } from "zod";
import {
  createOpenCodeServerManager,
  createOpenCodeSseConsumer,
  type OpenCodeServerManager,
  type OpenCodeServerProcess
} from "./opencode-sse.ts";
import { errorMessage, splitLines } from "./subprocess-run.ts";
import type { AutonomousRequest, LlmBackend } from "./types.ts";
import { StreamConversation } from "../conversation/index.ts";
import { backendFailed, jsonSchemaFromZod, type BackendConfig } from "../model/index.ts";

/** HTTP/SSE surface the driver needs from an `opencode serve` instance (Scala
 * `OpencodeHttp`). The default is `fetch`-backed (integration only); unit tests
 * inject a scripted fake. `openEvents` resolves once the SSE connection is open
 * so the turn-starting POST can't race ahead of the stream. */
export interface OpenCodeHttp {
  postJson(path: string, body: string): Promise<string>;
  openEvents(signal: AbortSignal): Promise<AsyncIterable<string>>;
}

export interface OpenCodeBackend extends LlmBackend<"opencode"> {
  /** Stop the shared `opencode serve` process. Caller-invoked at runtime end —
   * orca-ts has no global scope hook, so the backend owner drives teardown. */
  shutdown(signal?: NodeJS.Signals): Promise<void>;
}

export interface OpenCodeBackendOptions {
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly capacity?: number;
  readonly config?: BackendConfig<"opencode">;
  /** Fail the turn if the `/event` stream delivers nothing for this many ms.
   * opencode 1.16.2 can stop emitting events entirely (no `session.idle`, no
   * heartbeat) — e.g. when a structured-output turn follows tool use — which
   * would otherwise hang the driver forever. Defaults to 120s; an actively
   * streaming turn resets the timer on every event, so legitimate slow turns are
   * unaffected. */
  readonly inactivityTimeoutMs?: number;
  /** Seam: start (or reuse) the serve process. Defaults to spawning `opencode serve`. */
  readonly startServer?: () => Promise<OpenCodeServerProcess>;
  /** Seam: build an HTTP/SSE client for a started server. Defaults to `fetch`. */
  readonly connect?: (server: OpenCodeServerProcess) => OpenCodeHttp;
}

interface ResolvedOpenCodeConfig<Output> {
  model?: string;
  systemPrompt?: string;
  readOnly?: boolean;
  schema?: z.ZodType<Output>;
  resumeSessionId?: string;
}

export async function runOpenCodeConversation<Output>(
  request: AutonomousRequest<Output, "opencode">,
  options: OpenCodeBackendOptions,
  manager: OpenCodeServerManager,
  connect: (server: OpenCodeServerProcess) => OpenCodeHttp,
  conversation: StreamConversation<"opencode">
): Promise<void> {
  const config = resolveOpenCodeConfig(request, options);

  // Stream-scoped: closed in `finally` on every exit (success, error, cancel) so
  // a turn doesn't leak its SSE connection against the shared server — mirrors
  // Scala `OpencodeBackend.runAutonomous`'s `finally source.interrupt()`.
  // `session.idle` is an event *on* the stream, not the stream ending, so a
  // successful turn must close it explicitly.
  const streamController = new AbortController();
  const forwardAbort = (): void => {
    streamController.abort();
  };
  if (conversation.signal.aborted) {
    streamController.abort();
  } else {
    conversation.signal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const server = await manager.get();
    const http = connect(server);

    // Open the SSE stream first so no turn events are missed, then start the turn.
    const events = await http.openEvents(streamController.signal);
    const serverSession = await resolveServerSession(http, config.resumeSessionId);
    const body = openCodeMessageBody(request.prompt, config);
    await http.postJson(`/session/${serverSession}/prompt_async`, body);

    const consumer = createOpenCodeSseConsumer(conversation);
    const inactivityMs = options.inactivityTimeoutMs ?? 120_000;
    const iterator = events[Symbol.asyncIterator]();
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const inactivity = new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => {
          resolve("stalled");
        }, inactivityMs);
      });
      const next = await Promise.race([iterator.next(), inactivity]);
      clearTimeout(timer);

      if (next === "stalled") {
        if (!conversation.signal.aborted) {
          conversation.fail(
            backendFailed(
              "opencode",
              `opencode emitted no event for ${String(inactivityMs)}ms; treating the turn as stalled`
            )
          );
        }
        return;
      }
      if (next.done) {
        break;
      }
      if (conversation.signal.aborted) {
        return;
      }
      await consumer.consume(next.value);
      if (consumer.completed) {
        return;
      }
    }

    if (!conversation.signal.aborted) {
      consumer.finish();
    }
  } catch (error) {
    if (!conversation.signal.aborted) {
      conversation.fail(backendFailed("opencode", errorMessage(error)));
    }
  } finally {
    conversation.signal.removeEventListener("abort", forwardAbort);
    streamController.abort();
  }
}

async function resolveServerSession(
  http: OpenCodeHttp,
  resumeSessionId: string | undefined
): Promise<string> {
  if (resumeSessionId) {
    return resumeSessionId;
  }
  const response = await http.postJson("/session", JSON.stringify({}));
  return (JSON.parse(response) as { readonly id: string }).id;
}

function openCodeMessageBody<Output>(prompt: string, config: ResolvedOpenCodeConfig<Output>): string {
  const tools = toolFlags(config.readOnly);
  return JSON.stringify({
    parts: [{ type: "text", text: prompt }],
    ...(config.model === undefined ? {} : { model: splitModel(config.model) }),
    ...(config.systemPrompt === undefined ? {} : { system: config.systemPrompt }),
    ...(tools === undefined ? {} : { tools }),
    ...(config.schema === undefined
      ? {}
      : { format: { type: "json_schema", schema: jsonSchemaFromZod(config.schema) } })
  });
}

/** Autonomous turns disable the native `question` tool (nobody can answer);
 * read-only turns also disable the write tools. */
function toolFlags(readOnly: boolean | undefined): Record<string, boolean> | undefined {
  const flags: Record<string, boolean> = { question: false };
  if (readOnly) {
    flags.write = false;
    flags.edit = false;
    flags.bash = false;
    flags.patch = false;
  }
  return flags;
}

function splitModel(model: string): { readonly providerID: string; readonly modelID: string } {
  const slash = model.indexOf("/");
  if (slash < 0) {
    return { providerID: model, modelID: "" };
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function resolveOpenCodeConfig<Output>(
  request: AutonomousRequest<Output, "opencode">,
  options: OpenCodeBackendOptions
): ResolvedOpenCodeConfig<Output> {
  const config: ResolvedOpenCodeConfig<Output> = {};
  const optionConfig = options.config;
  const requestConfig = request.config;

  setValue(config, "model", requestConfig?.model ?? optionConfig?.model);
  setValue(config, "systemPrompt", requestConfig?.systemPrompt ?? optionConfig?.systemPrompt);
  setValue(config, "readOnly", requestConfig?.readOnly ?? optionConfig?.readOnly);
  setValue(
    config,
    "schema",
    requestConfig?.structuredOutput?.schema ??
      request.schema ??
      (optionConfig?.structuredOutput?.schema as z.ZodType<Output> | undefined)
  );
  setValue(
    config,
    "resumeSessionId",
    requestConfig?.resumeSessionId === undefined ? undefined : String(requestConfig.resumeSessionId)
  );

  return config;
}

function setValue<Output, Key extends keyof ResolvedOpenCodeConfig<Output>>(
  config: ResolvedOpenCodeConfig<Output>,
  key: Key,
  value: ResolvedOpenCodeConfig<Output>[Key]
): void {
  if (value !== undefined) {
    config[key] = value;
  }
}

export function opencode(options: OpenCodeBackendOptions = {}): OpenCodeBackend {
  const manager = createOpenCodeServerManager({
    start: options.startServer ?? (() => defaultStartServer(options))
  });
  const connect = options.connect ?? createFetchOpenCodeHttp;

  return {
    tag: "opencode",
    autonomous<Output = unknown>(request: AutonomousRequest<Output, "opencode">) {
      const conversation = new StreamConversation({
        backend: "opencode",
        capacity: options.capacity ?? 256,
        canAskUser: false
        // Cancellation aborts the conversation signal, which closes the SSE
        // stream the driver is reading; the shared server is left running.
      });

      queueMicrotask(() => {
        void runOpenCodeConversation(request, options, manager, connect, conversation);
      });

      return conversation;
    },
    async shutdown(signal?: NodeJS.Signals) {
      await manager.shutdown(signal);
    }
  };
}

// --- Default `fetch` + `opencode serve` transport (integration only) ---

const ListeningLine = /listening on (https?:\/\/\S+)/;

async function defaultStartServer(options: OpenCodeBackendOptions): Promise<OpenCodeServerProcess> {
  const command = options.command ?? "opencode";
  const password = crypto.randomUUID();
  // Preemptive Basic auth: the spawn handed the server this password via env, so
  // every request must carry it or the server replies 401 (Scala JavaNetOpencodeHttp).
  const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const child = spawn(command, ["serve", "--port", "0", "--log-level", "WARN"], {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"]
  });

  // Read until the "listening on …" line WITHOUT breaking the stream: a `break`
  // out of `for await (splitLines(stdout))` calls the iterator's `.return()`,
  // which destroys `child.stdout` — then the server can't drain and a post-startup
  // log write hits a closed pipe. Instead attach a persistent `data` listener
  // (keeps the stream in flowing mode, draining forever) and resolve off it.
  const stdout = child.stdout;
  let baseUrl: string;
  try {
    baseUrl = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      let resolved = false;
      stdout.on("data", (chunk: Buffer | string) => {
        if (resolved) {
          return; // listener stays attached purely to drain the pipe
        }
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const match = ListeningLine.exec(buffer);
        if (match?.[1] !== undefined) {
          resolved = true;
          resolve(match[1]);
        }
      });
      child.once("error", (error: Error) => {
        if (!resolved) {
          reject(error);
        }
      });
      stdout.once("end", () => {
        if (!resolved) {
          reject(new Error("opencode serve did not report a listening URL"));
        }
      });
    });
  } catch (error) {
    child.kill("SIGINT");
    throw error;
  }

  return {
    url: baseUrl,
    authHeader,
    stop(signal = "SIGINT") {
      child.kill(signal);
      return Promise.resolve();
    }
  };
}

/** Default `fetch`-backed transport (Scala `JavaNetOpencodeHttp`). Sends the
 * server's preemptive `Authorization` header on every request and surfaces
 * non-2xx responses as errors instead of returning the body as success. */
export function createFetchOpenCodeHttp(server: OpenCodeServerProcess): OpenCodeHttp {
  const headers: Record<string, string> = server.authHeader
    ? { authorization: server.authHeader }
    : {};
  return {
    async postJson(path, body) {
      const response = await fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body
      });
      if (!response.ok) {
        const errorBody = (await response.text()).trim();
        throw new Error(
          `opencode POST ${path} failed with ${String(response.status)}${errorBody ? `: ${errorBody}` : ""}`
        );
      }
      return await response.text();
    },
    async openEvents(signal) {
      const response = await fetch(`${server.url}/event`, { headers, signal });
      if (!response.ok) {
        throw new Error(`opencode GET /event failed with ${String(response.status)}`);
      }
      if (!response.body) {
        throw new Error("opencode /event returned no body");
      }
      return splitLines(streamBytes(response.body));
    }
  };
}

async function* streamBytes(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
