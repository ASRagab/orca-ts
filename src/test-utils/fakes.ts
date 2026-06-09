import type { ConversationEvent, LlmResult } from "../model/index.ts";

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
