import { sessionId, type BackendConfig, type SessionId } from "../../src/index.ts";

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

// @ts-expect-error backend config resume handles must match the backend brand
const claudeConfig: BackendConfig<"claude"> = { resumeSessionId: codexSession };
void claudeConfig;
