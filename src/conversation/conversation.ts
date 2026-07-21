import { err, ok, type Result } from "neverthrow";
import {
  type BackendResult,
  type BackendTag,
  type ConversationEvent,
  type RuntimeError,
  backendFailed,
  unsupportedFeature
} from "../model/index.ts";
import { BoundedAsyncQueue } from "./queue.ts";
import {
  deferConversationSettlement,
  markConversationCancellationComplete,
  registerConversationCancellationFailureHandler
} from "./settlement-reservation.ts";

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
    if (this.cancellation !== undefined) {
      return;
    }
    const outcome: Outcome<B> = { type: "success", result };
    if (
      deferConversationSettlement(this, "success", () => {
        if (this.cancellation === undefined) {
          this.complete(outcome);
        }
      })
    ) {
      return;
    }
    this.complete(outcome);
  }

  fail(error: RuntimeError): void {
    if (this.cancellation !== undefined) {
      return;
    }
    const outcome: Outcome<B> = { type: "failed", error };
    if (
      deferConversationSettlement(this, "failure", () => {
        if (this.cancellation === undefined) {
          this.complete(outcome);
        }
      })
    ) {
      return;
    }
    this.complete(outcome);
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
    registerConversationCancellationFailureHandler(this, (error: unknown) => {
      this.completeCancellationFailure(error, cancellation.reject);
    });

    let cleanup: Promise<void>;
    try {
      this.abortController.abort(reason);
      cleanup = Promise.resolve(this.options.onCancel?.(reason));
    } catch (error) {
      this.completeCancellationFailure(error, cancellation.reject);
      return cancellation.promise;
    }

    void cleanup.then(
      () => {
        const outcome: Outcome<B> =
          reason === undefined ? { type: "cancelled" } : { type: "cancelled", reason };
        const publish = (): void => {
          this.complete(outcome);
          cancellation.resolve(undefined);
        };
        if (!deferConversationSettlement(this, "cancellation", publish)) {
          publish();
        }
        markConversationCancellationComplete(this);
      },
      (error: unknown) => {
        this.completeCancellationFailure(error, cancellation.reject);
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

  private completeCancellationFailure(
    error: unknown,
    rejectCancellation: (reason?: unknown) => void
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const outcome: Outcome<B> = {
      type: "failed",
      error: backendFailed(this.backend, `${this.backend} cancellation cleanup failed: ${message}`)
    };
    const publish = (): void => {
      this.complete(outcome);
      rejectCancellation(error);
    };
    if (!deferConversationSettlement(this, "cancellation_failure", publish)) {
      publish();
    }
    markConversationCancellationComplete(this);
  }
}
