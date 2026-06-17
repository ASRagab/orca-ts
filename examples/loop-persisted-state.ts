import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshotStore, isComplete, type StateReducer, type TaskManifest } from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "orca-loop-state-"));
const store = createSnapshotStore({ root });

const initial: TaskManifest = {
  tasks: [
    { id: "write-guide", passes: false },
    { id: "check-links", passes: false },
  ],
};

const mergeByPass: StateReducer<TaskManifest> = (states) => ({
  tasks: initial.tasks.map((task) => ({
    id: task.id,
    passes: states.some((state) => state.tasks.find((candidate) => candidate.id === task.id)?.passes === true),
  })),
});

const base = await store.checkpoint(initial);
if (base.isErr()) throw new Error(JSON.stringify(base.error));

const branchA = await store.branch(base.value);
if (branchA.isErr()) throw new Error(JSON.stringify(branchA.error));

const branchB = await store.branch(base.value);
if (branchB.isErr()) throw new Error(JSON.stringify(branchB.error));

const wroteGuide = await store.checkpoint({
  tasks: [
    { id: "write-guide", passes: true },
    { id: "check-links", passes: false },
  ],
});
if (wroteGuide.isErr()) throw new Error(JSON.stringify(wroteGuide.error));

const checkedLinks = await store.checkpoint({
  tasks: [
    { id: "write-guide", passes: false },
    { id: "check-links", passes: true },
  ],
});
if (checkedLinks.isErr()) throw new Error(JSON.stringify(checkedLinks.error));

const merged = await store.merge([wroteGuide.value, checkedLinks.value], mergeByPass);
if (merged.isErr()) throw new Error(JSON.stringify(merged.error));

const history = await store.history();
if (history.isErr()) throw new Error(JSON.stringify(history.error));

console.log(`state root: ${root}`);
console.log(`branch handles: ${branchA.value}, ${branchB.value}`);
console.log(`history entries: ${String(history.value.length)}`);
console.log(`complete: ${String(isComplete(merged.value))}`);
