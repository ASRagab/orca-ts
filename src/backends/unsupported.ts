import type { AutonomousRequest, LlmBackend } from "./types.ts";
import { StreamConversation } from "../conversation/index.ts";
import {
  backendFailed,
  sessionId,
  unsupportedFeature,
  type BackendTag,
  type SessionId
} from "../model/index.ts";

export function unsupportedBackend<B extends BackendTag>(tag: B): LlmBackend<B> {
  return {
    tag,
    autonomous(request: AutonomousRequest) {
      const conversation = new StreamConversation({ backend: tag });
      queueMicrotask(() => {
        if (request.config?.resumeSessionId) {
          conversation.fail(
            unsupportedFeature(`${tag} resume`, `${tag} backend does not support session resume`)
          );
          return;
        }
        if (request.schema || request.config?.structuredOutput) {
          conversation.fail(
            unsupportedFeature(
              `${tag} structured output`,
              `${tag} backend does not support live structured output`
            )
          );
          return;
        }
        conversation.fail(backendFailed(tag, `${tag} backend is not implemented yet`));
      });
      return conversation;
    }
  };
}

export const gemini = () => unsupportedBackend("gemini");

export function fakeResult<B extends BackendTag>(
  backend: B,
  output: string
): { readonly backend: B; readonly sessionId: SessionId<B>; readonly output: string } {
  return {
    backend,
    sessionId: sessionId(backend, `${backend}-fake-session`),
    output
  };
}
