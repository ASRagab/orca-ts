// Archetype: multi-backend-compare
// Run the SAME prompt across several backends in isolation and print a
// comparison (outcome + token usage). Read-only by default so it does not
// mutate the repo — use it to pick a backend before committing to one in a
// real workflow. Pins backends directly (does not honor --backend).
//
// SLOTS the author skill fills:
//   - PROMPT   : the task to compare across backends
//   - BACKENDS : which backends to include
import { claude, codex, flow, flowArgs, llm, opencode, pi } from "orca-ts";
import type { LlmBackend } from "orca-ts";

const PROMPT = "REPLACE_WITH_PROMPT";

interface Candidate {
  readonly tag: string;
  readonly backend: LlmBackend;
  readonly shutdown?: () => Promise<void>;
}

await flow(flowArgs())(async () => {
  const ocBackend = opencode({ config: { readOnly: true } });
  // ── SLOT: choose which backends to compare ──────────────────────────────
  const candidates: readonly Candidate[] = [
    { tag: "claude", backend: claude({ config: { readOnly: true } }) },
    { tag: "codex", backend: codex({ config: { readOnly: true } }) },
    { tag: "opencode", backend: ocBackend, shutdown: () => ocBackend.shutdown() },
    { tag: "pi", backend: pi({ config: { readOnly: true } }) },
  ];

  const rows: string[] = [];
  try {
    for (const candidate of candidates) {
      const started = Date.now();
      const outcome = await llm().autonomous(candidate.backend, { prompt: PROMPT }).awaitResult();
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const tokens =
        outcome.type === "success" && outcome.result.usage
          ? String(outcome.result.usage.input + outcome.result.usage.output)
          : "-";
      rows.push(`${candidate.tag.padEnd(9)} ${outcome.type.padEnd(10)} ${seconds.padStart(6)}s  ${tokens} tok`);
    }
  } finally {
    for (const candidate of candidates) {
      await candidate.shutdown?.();
    }
  }

  console.log("backend   outcome     time    usage");
  console.log(rows.join("\n"));
});
