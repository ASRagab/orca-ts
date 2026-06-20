import {
  claude,
  flow,
  llm,
  ok,
  parseStructuredOutput,
  z,
  type ConversationEvent
} from "../../src/index.ts";
import type { Result } from "neverthrow";
import type { RuntimeError } from "../../src/model/index.ts";
import type { StateHash, StateReducer, StateStore } from "../../src/index.ts";

void flow;
void llm;
void claude;
void parseStructuredOutput;
void z;
void ok;

const event: ConversationEvent = { type: "assistant_turn_end" };
void event;

// @ts-expect-error executeLoop is internal; public loop entrypoint is loop().
import { executeLoop } from "../../src/index.ts";
void executeLoop;

const existingStoreImplementation: StateStore<{ readonly value: number }> = {
  load(): Promise<Result<{ readonly value: number }, RuntimeError>> {
    return Promise.resolve(ok({ value: 1 }));
  },
  checkpoint(): Promise<Result<StateHash, RuntimeError>> {
    return Promise.resolve(ok("checkpoint"));
  },
  branch(): Promise<Result<StateHash, RuntimeError>> {
    return Promise.resolve(ok("branch"));
  },
  merge(_branches: readonly StateHash[], reducer: StateReducer<{ readonly value: number }>) {
    return Promise.resolve(ok(reducer([{ value: 1 }])));
  },
  history(): Promise<Result<readonly StateHash[], RuntimeError>> {
    return Promise.resolve(ok([]));
  },
};
void existingStoreImplementation;
