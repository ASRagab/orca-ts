import { fanIn, fanOut, loop, type Branch, type BranchSummary } from "../src/index.ts";

// A fan-out / fan-in loop — a batch map-reduce. Each cycle fans the next batch of pending files out
// to bounded-concurrency branches; every branch works on an ISOLATED `structuredClone` of the state
// (copy-on-fanout, never shared-mutable), so all branches in a cycle see the same pre-fanout
// snapshot. `fanIn` then folds the per-branch summaries through the reducer — the ONLY place branch
// results recombine — and a `.step()` moves the batch from pending to done. The loop drives the
// remaining-file count to zero. Fan-out / fan-in are opt-in: a plain single-cycle loop never needs them.

interface SurveyState {
  readonly pending: readonly string[];
  readonly summaries: readonly string[];
}

const FILES = ["auth.ts", "router.ts", "db.ts", "cache.ts", "queue.ts", "metrics.ts", "config.ts"];
const BATCH = 3;

/** A pure branch: summarize one file over its isolated state copy. Swap the body for a `.reason()`
 * / `llm()` call to dispatch a real backend per branch. The branch reads the isolated snapshot to
 * show every branch in a cycle observes the same prior progress. */
const summarizeFile =
  (file: string): Branch<SurveyState, string> =>
  (isolated) => ({
    summary: `summary of ${file} (after ${String(isolated.summaries.length)} prior)`,
    data: file,
  });

const result = await loop<SurveyState>("survey")
  .step("summarize-batch", async (state) => {
    const batch = state.pending.slice(0, BATCH);

    const fanned = await fanOut<SurveyState, string>({
      state,
      branches: batch.map(summarizeFile),
      maxConcurrency: BATCH,
    });
    if (fanned.isErr()) throw new Error(`fan-out failed: ${fanned.error.reason}`);

    const merged = fanIn<readonly string[], string>("barrier", fanned.value, {
      reducer: (summaries: readonly BranchSummary<string>[]) => summaries.map((entry) => entry.summary),
    });
    if (merged.isErr()) throw new Error(`fan-in failed: ${merged.error.kind}`);

    return {
      pending: state.pending.slice(batch.length),
      summaries: [...state.summaries, ...merged.value],
    };
  })
  .measure((state) => state.pending.length)
  .guard({ maxIterations: 20 })
  .run({ pending: FILES, summaries: [] });

if (result.isErr()) {
  console.error(`loop failed: ${JSON.stringify(result.error)}`);
  process.exit(1);
}

const outcome = result.value;
console.log(`stop reason: ${outcome.stopReason}`);
console.log(`iterations:  ${String(outcome.iterations)}`);
console.log(`files summarized: ${String(outcome.state.summaries.length)}`);
for (const summary of outcome.state.summaries) console.log(`  - ${summary}`);
