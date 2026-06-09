import {
  backendFailed,
  type BackendTag,
  type ConversationEvent
} from "../model/index.ts";
import { StreamConversation, type Outcome } from "./conversation.ts";

export interface ConversationCapture<B extends BackendTag> {
  readonly events: readonly ConversationEvent[];
  readonly outcome: Outcome<B>;
}

export interface ConversationHarnessOptions<B extends BackendTag> {
  readonly backend: B;
  readonly capacity?: number;
  readonly canAskUser?: boolean;
  readonly consume: (conversation: StreamConversation<B>) => Promise<void> | void;
}

export async function collectConversation<B extends BackendTag>(
  options: ConversationHarnessOptions<B>
): Promise<ConversationCapture<B>> {
  const conversation = new StreamConversation({
    backend: options.backend,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    ...(options.canAskUser === undefined ? {} : { canAskUser: options.canAskUser })
  });

  try {
    await options.consume(conversation);
  } catch (error) {
    conversation.fail(backendFailed(options.backend, errorMessage(error)));
  }

  const events: ConversationEvent[] = [];
  for await (const event of conversation.events()) {
    events.push(event);
  }

  return { events, outcome: await conversation.awaitResult() };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
