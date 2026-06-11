import type { ConversationEvent, LlmResult } from "../model/index.ts";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";
import type { LlmBackend, LlmTool, AutonomousRequest } from "../backends/types.ts";
import { StreamConversation, type Conversation } from "../conversation/conversation.ts";
import { sessionId } from "../model/brand.ts";
import type { BackendTag } from "../model/schemas.ts";

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
