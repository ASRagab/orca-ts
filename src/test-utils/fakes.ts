import type { ConversationEvent, LlmResult } from "../model/index.ts";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";
import type { LlmBackend, LlmTool, AutonomousRequest } from "../backends/types.ts";
import { StreamConversation, type Conversation } from "../conversation/conversation.ts";
import { sessionId } from "../model/brand.ts";
import type { BackendTag } from "../model/schemas.ts";
import type { Sink, Source, SourceSubscription } from "../loop/io/index.ts";

export interface FakeSubprocess {
  readonly lines: readonly string[];
  readonly stderr?: string;
  readonly exitCode?: number;
}

export interface FakeHttpSseTransport {
  readonly events: readonly string[];
}

export interface FakeRpcTransport<Request = unknown, Response = unknown> {
  readonly requests: Request[];
  readonly responses: Response[];
}

export interface FakeAgentRun {
  readonly events: readonly ConversationEvent[];
  readonly result: LlmResult;
  readonly diff?: string;
}

export interface ScriptedFakeAgentStep {
  readonly events?: readonly ConversationEvent[];
  readonly output?: string;
  readonly diff?: string;
  readonly failure?: RuntimeError;
}

export interface ScriptedFakeAgent {
  run(prompt: string): Promise<Result<FakeAgentRun, RuntimeError>>;
  readonly prompts: readonly string[];
}

export function scriptedSubprocess(lines: readonly string[]): FakeSubprocess {
  return { lines };
}

export function scriptedSse(events: readonly string[]): FakeHttpSseTransport {
  return { events };
}

export function scriptedRpc<Request, Response>(
  responses: readonly Response[]
): FakeRpcTransport<Request, Response> {
  return { requests: [], responses: [...responses] };
}

export function fakeAgentRun(events: readonly ConversationEvent[], result: LlmResult): FakeAgentRun {
  return { events, result };
}

export interface FakeLlmBackend extends LlmBackend<"codex"> {
  readonly calls: readonly string[];
}

export function fakeBackend(outputs: readonly string[]): FakeLlmBackend {
  const queue = [...outputs];
  const calls: string[] = [];
  return {
    tag: "codex" as const,
    calls,
    autonomous<Output>(request: AutonomousRequest<Output, "codex">): Conversation<"codex"> {
      calls.push(request.prompt);
      const output = queue.shift();
      if (output === undefined) {
        throw new Error(`fakeBackend: scripted outputs exhausted (${String(calls.length)} calls made)`);
      }
      const callIndex = calls.length;
      const conv = new StreamConversation<"codex">({ backend: "codex" });
      void Promise.resolve().then(async () => {
        await conv.emit({ type: "assistant_text_delta", text: output });
        await conv.emit({ type: "assistant_turn_end" });
        conv.succeed({
          backend: "codex",
          sessionId: sessionId("codex", `fake-session-${String(callIndex)}`),
          output,
        });
      });
      return conv;
    }
  };
}

export interface EventRecorder<E = ConversationEvent> {
  readonly push: (event: E) => void;
  readonly events: () => readonly E[];
}

export function eventRecorder<E = ConversationEvent>(): EventRecorder<E> {
  const captured: E[] = [];
  return {
    push: (event) => { captured.push(event); },
    events: () => captured,
  };
}

export function createFakeLlmTool(fake: FakeLlmBackend): LlmTool {
  return {
    autonomous<B extends BackendTag, Output>(_backend: LlmBackend<B>, req: AutonomousRequest<Output, B>) {
      return fake.autonomous(req as unknown as AutonomousRequest<Output, "codex">) as unknown as Conversation<B>;
    }
  };
}

export function scriptedFakeAgent(steps: readonly ScriptedFakeAgentStep[]): ScriptedFakeAgent {
  const prompts: string[] = [];
  const queue = [...steps];

  return {
    prompts,
    run(prompt) {
      prompts.push(prompt);
      const step = queue.shift();
      if (!step) {
        return Promise.resolve(err({
          _tag: "BackendFailed",
          backend: "codex",
          message: "scripted fake agent exhausted"
        }));
      }
      if (step.failure) {
        return Promise.resolve(err(step.failure));
      }
      const run: FakeAgentRun = {
        events: step.events ?? [],
        result: {
          backend: "codex",
          sessionId: "fake-agent-session",
          output: step.output ?? ""
        }
      };
      return Promise.resolve(ok({
        ...run,
        ...(step.diff === undefined ? {} : { diff: step.diff })
      }));
    }
  };
}

// --- Fake Source / Sink (loop-io spec): in-memory, so a loop runs end to end with no real ---
// --- trigger or output IO. The fake sink captures emitted outputs; the fake source fires on demand. ---

export interface FakeSource<E> extends Source<E> {
  readonly kind: "manual";
  /** Push a trigger event to the started handler. No-op until started / after stop. */
  fire(event: E): void;
  /** Whether a handler is currently subscribed. */
  isStarted(): boolean;
}

export function fakeSource<E = void>(): FakeSource<E> {
  let handler: ((event: E) => void) | undefined;
  return {
    kind: "manual",
    isStarted: () => handler !== undefined,
    fire(event) {
      handler?.(event);
    },
    start(received) {
      handler = received;
      const sub: SourceSubscription = {
        stop() {
          handler = undefined;
          return Promise.resolve(ok(undefined));
        },
      };
      return Promise.resolve(ok(sub));
    },
  };
}

export interface FakeSink<A> extends Sink<A> {
  readonly kind: "stdout";
  /** Outputs captured by each successful emit, in order. */
  emitted(): readonly A[];
}

/** A capturing Sink. With `failWith`, every emit returns `err(RuntimeError)` and captures nothing. */
export function fakeSink<A = unknown>(options: { failWith?: RuntimeError } = {}): FakeSink<A> {
  const captured: A[] = [];
  const { failWith } = options;
  return {
    kind: "stdout",
    emitted: () => captured,
    emit(output) {
      if (failWith !== undefined) {
        return Promise.resolve(err(failWith));
      }
      captured.push(output);
      return Promise.resolve(ok(undefined));
    },
  };
}
