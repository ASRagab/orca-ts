import {
  sessionId,
  type BackendConfig,
  type PortableBackendConfig,
  type SessionId,
} from "../../src/index.ts";

const claudeSession = sessionId("claude", "c1");
const codexSession = sessionId("codex", "x1");
const piSession = sessionId("pi", "p1");

function acceptsClaude(session: SessionId<"claude">): void {
  void session;
}
function acceptsPi(session: SessionId<"pi">): void {
  void session;
}

acceptsClaude(claudeSession);
acceptsPi(piSession);

// @ts-expect-error backend session identifiers must not be interchangeable
acceptsClaude(codexSession);

const codexConfig: BackendConfig<"codex"> = { resumeSessionId: codexSession };
void codexConfig;

const codexReasoningConfig: BackendConfig<"codex"> = {
  reasoningEffort: "low",
};
void codexReasoningConfig;

const claudeReasoningConfig: BackendConfig<"claude"> = {
  // @ts-expect-error reasoning effort is Codex-only
  reasoningEffort: "low",
};
void claudeReasoningConfig;

const portableReasoningConfig: PortableBackendConfig = {
  // @ts-expect-error portable selector config contains only cross-backend fields
  reasoningEffort: "low",
};
void portableReasoningConfig;

// @ts-expect-error backend config resume handles must match the backend brand
const claudeConfig: BackendConfig<"claude"> = { resumeSessionId: codexSession };
void claudeConfig;
