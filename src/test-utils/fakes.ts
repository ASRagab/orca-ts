import type { ConversationEvent, LlmResult } from "../model/index.ts";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";

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
