import { loop, untilManifestComplete, type TaskManifest } from "../src/index.ts";
import { fakeBackend } from "../src/test-utils/index.ts";

// A single-cycle preset loop — the "Ralph" archetype. Each cycle the agent reasons about the
// next pending task, then a deterministic `.step()` marks one task complete. `untilManifestComplete()`
// supplies the loop variant (drive the pending-task count to zero), so the author writes no measure
// math and no `while`/Effect/queue plumbing: `.run()` lowers onto flow() + the generic fixLoop.

const manifest: TaskManifest = {
  tasks: [
    { id: "scaffold-module", passes: false },
    { id: "wire-routes", passes: false },
    { id: "add-tests", passes: false },
  ],
};

// `fakeBackend` keeps the example runnable end-to-end with no real CLI or auth — one canned reply
// per cycle. Swap it for `codex()` / `claude()` to drive a real backend through the same `.reason()`.
const agent = fakeBackend(["Implemented scaffold.", "Wired routes.", "Added tests."]);

/** One unit of progress per cycle: flip the first still-pending task to passing. */
const passOneTask = (state: TaskManifest): TaskManifest => {
  const index = state.tasks.findIndex((task) => !task.passes);
  if (index < 0) return state;
  return { tasks: state.tasks.map((task, i) => (i === index ? { ...task, passes: true } : task)) };
};

const result = await loop<TaskManifest>("ralph")
  .reason(agent, { prompt: "Pick the next pending task and implement it." })
  .step("mark-one-task-complete", passOneTask)
  .until(untilManifestComplete())
  .guard({ maxIterations: 10 })
  .run(manifest, {
    onCycle: (cycle) => {
      console.log(`cycle ${String(cycle.iteration)}: ${String(cycle.measure)} task(s) remaining`);
    },
  });

if (result.isErr()) {
  console.error(`loop failed: ${JSON.stringify(result.error)}`);
  process.exit(1);
}

const outcome = result.value;
console.log(`stop reason: ${outcome.stopReason}`);
console.log(`iterations:  ${String(outcome.iterations)}`);
console.log(`all tasks pass: ${String(outcome.state.tasks.every((task) => task.passes))}`);
