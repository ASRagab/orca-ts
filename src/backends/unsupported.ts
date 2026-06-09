import type { AutonomousRequest, LlmBackend } from "./types.ts";
import { StreamConversation } from "../conversation/index.ts";
import { backendFailed, sessionId, type BackendTag, type SessionId } from "../model/index.ts";

export function unsupportedBackend<B extends BackendTag>(tag: B): LlmBackend<B> {
  return {
    tag,
    autonomous(_request: AutonomousRequest) {
      const conversation = new StreamConversation({ backend: tag });
      queueMicrotask(() => {
        conversation.fail(backendFailed(tag, `${tag} backend is not implemented yet`));
      });
      return conversation;
    }
  };
}

export const claude = () => unsupportedBackend("claude");
export const opencode = () => unsupportedBackend("opencode");
export const pi = () => unsupportedBackend("pi");
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
