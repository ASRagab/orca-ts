import { err, ok, type Result } from "neverthrow";
import {
  type BackendResult,
  type BackendTag,
  type ConversationEvent,
  type RuntimeError,
  unsupportedFeature
} from "../model/index.ts";
import { BoundedAsyncQueue } from "./queue.ts";
import { isConversationSettlementReserved } from "./settlement-reservation.ts";

export type Outcome<B extends BackendTag = BackendTag> =
  | { readonly type: "success"; readonly result: BackendResult<B> }
  | { readonly type: "cancelled"; readonly reason?: string }
  | { readonly type: "failed"; readonly error: RuntimeError };

export interface Conversation<B extends BackendTag = BackendTag> {
  readonly backend: B;
  readonly canAskUser: boolean;
  readonly signal: AbortSignal;
  events(): AsyncIterable<ConversationEvent>;
  awaitResult(): Promise<Outcome<B>>;
  cancel(reason?: string): Promise<void>;
}

export interface StreamConversationOptions<B extends BackendTag> {
  readonly backend: B;
  readonly capacity?: number;
  readonly canAskUser?: boolean;
  readonly onCancel?: (reason?: string) => Promise<void> | void;
}

export class StreamConversation<B extends BackendTag> implements Conversation<B> {
  private readonly abortController = new AbortController();

  readonly canAskUser: boolean;
  readonly signal = this.abortController.signal;

  private readonly queue: BoundedAsyncQueue<ConversationEvent>;
  private readonly outcome: Promise<Outcome<B>>;
  private settle!: (outcome: Outcome<B>) => void;
  private settled = false;
  private cancellation: Promise<void> | undefined;

  constructor(private readonly options: StreamConversationOptions<B>) {
    this.queue = new BoundedAsyncQueue(options.capacity ?? 32);
    this.canAskUser = options.canAskUser ?? false;
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
    let unsupportedReason: string | undefined;

    if (event.type === "user_question" && !this.canAskUser) {
      unsupportedReason = "Human interaction events require an explicit interactive conversation";
    } else if (event.type === "approve_tool") {
      unsupportedReason = "Live approval events are unsupported for autonomous execution";
    }

    if (unsupportedReason !== undefined) {
      const error = unsupportedFeature(event.type, unsupportedReason);
      this.fail(error);
      return err(error);
    }

    await this.queue.push(event);
    return ok(undefined);
  }

  succeed(result: BackendResult<B>): void {
    if (this.cancellation !== undefined || isConversationSettlementReserved(this)) {
      return;
    }
    this.complete({ type: "success", result });
  }

  fail(error: RuntimeError): void {
    if (this.cancellation !== undefined || isConversationSettlementReserved(this)) {
      return;
    }
    this.complete({ type: "failed", error });
  }

  cancel(reason?: string): Promise<void> {
    if (this.settled) {
      return Promise.resolve();
    }
    if (this.cancellation !== undefined) {
      return this.cancellation;
    }

    const cancellation = Promise.withResolvers<undefined>();
    this.cancellation = cancellation.promise;

    let cleanup: Promise<void>;
    try {
      this.abortController.abort(reason);
      cleanup = Promise.resolve(this.options.onCancel?.(reason));
    } catch (error) {
      cancellation.reject(error);
      return cancellation.promise;
    }

    void cleanup.then(
      () => {
        this.complete(reason === undefined ? { type: "cancelled" } : { type: "cancelled", reason });
        cancellation.resolve(undefined);
      },
      (error: unknown) => {
        cancellation.reject(error);
      }
    );
    return cancellation.promise;
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
