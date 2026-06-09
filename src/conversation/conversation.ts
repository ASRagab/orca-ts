import { err, ok, type Result } from "neverthrow";
import {
  type BackendTag,
  type ConversationEvent,
  type LlmResult,
  type RuntimeError,
  unsupportedFeature
} from "../model/index.ts";
import { BoundedAsyncQueue } from "./queue.ts";

export type Outcome<B extends BackendTag = BackendTag> =
  | { readonly type: "success"; readonly result: LlmResult & { readonly backend: B } }
  | { readonly type: "cancelled"; readonly reason?: string }
  | { readonly type: "failed"; readonly error: RuntimeError };

export interface Conversation<B extends BackendTag = BackendTag> {
  readonly backend: B;
  readonly canAskUser: false;
  readonly signal: AbortSignal;
  events(): AsyncIterable<ConversationEvent>;
  awaitResult(): Promise<Outcome<B>>;
  cancel(reason?: string): Promise<void>;
}

export interface StreamConversationOptions<B extends BackendTag> {
  readonly backend: B;
  readonly capacity?: number;
  readonly onCancel?: (reason?: string) => Promise<void> | void;
}

export class StreamConversation<B extends BackendTag> implements Conversation<B> {
  readonly canAskUser = false;
  readonly signal: AbortSignal;

  private readonly queue: BoundedAsyncQueue<ConversationEvent>;
  private readonly abortController = new AbortController();
  private readonly outcome: Promise<Outcome<B>>;
  private settle!: (outcome: Outcome<B>) => void;
  private settled = false;

  constructor(private readonly options: StreamConversationOptions<B>) {
    this.queue = new BoundedAsyncQueue(options.capacity ?? 32);
    this.signal = this.abortController.signal;
    this.outcome = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  get backend(): B {
    return this.options.backend;
  }

  events(): AsyncIterable<ConversationEvent> {
    return this.queue;
  }

  awaitResult(): Promise<Outcome<B>> {
    return this.outcome;
  }

  async emit(event: ConversationEvent): Promise<Result<void, RuntimeError>> {
    if (event.type === "user_question" || event.type === "approve_tool") {
      const error = unsupportedFeature(
        event.type,
        "Human interaction events are reserved but unsupported in v1"
      );
      this.fail(error);
      return err(error);
    }

    await this.queue.push(event);
    return ok(undefined);
  }

  succeed(result: LlmResult & { readonly backend: B }): void {
    this.complete({ type: "success", result });
  }

  fail(error: RuntimeError): void {
    this.complete({ type: "failed", error });
  }

  async cancel(reason?: string): Promise<void> {
    if (this.settled) {
      return;
    }

    this.abortController.abort(reason);
    await this.options.onCancel?.(reason);
    this.complete(reason === undefined ? { type: "cancelled" } : { type: "cancelled", reason });
  }

  private complete(outcome: Outcome<B>): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.queue.close();
    this.settle(outcome);
  }
}
