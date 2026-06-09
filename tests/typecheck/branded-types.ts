import { sessionId, type SessionId } from "../../src/index.ts";

const claudeSession = sessionId("claude", "c1");
const codexSession = sessionId("codex", "x1");
const piSession = sessionId("pi", "p1");

function acceptsClaude(_session: SessionId<"claude">): void {}
function acceptsPi(_session: SessionId<"pi">): void {}

acceptsClaude(claudeSession);
acceptsPi(piSession);

// @ts-expect-error backend session identifiers must not be interchangeable
acceptsClaude(codexSession);
