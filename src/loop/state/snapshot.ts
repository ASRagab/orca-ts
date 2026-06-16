import { createHash } from "node:crypto";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../../model/index.ts";
import { createFsTool, type FsTool } from "../../tools/index.ts";
import { parseManifest, type TaskManifest } from "./manifest.ts";
import type { StateHash, StateReducer, StateStore } from "./port.ts";

// `snapshot` is the zero-config default adapter (design D4): the whole manifest is
// written as JSON to `.orca/state-<hash>.json` per cycle — human-readable,
// git-diffable, zero deps. `branch` = copy-on-fanout, `merge` = reducer (the only
// merge point), `history` = the in-process cycle stream. The snapshot adapter
// trades durability for simplicity: an interrupt loses the current cycle, so the
// monitor history lives in memory; finer per-step resume is the `sqlite` adapter.

export interface SnapshotStoreOptions {
  /** Repo/working root; snapshots land under `<root>/.orca/`. */
  readonly root: string;
  /** Injectable filesystem for tests; defaults to the real adapter. */
  readonly fsTool?: FsTool;
}

/** Content hash of a manifest — canonical JSON so equal manifests share a file. */
export function stateHash(manifest: TaskManifest): StateHash {
  const canonical = JSON.stringify({
    tasks: manifest.tasks.map(({ id, passes }) => ({ id, passes }))
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/** Per-cycle snapshot path: `<root>/.orca/state-<hash>.json`. */
export function statePath(root: string, hash: StateHash): string {
  return join(root, ".orca", `state-${hash}.json`);
}

export function createSnapshotStore(options: SnapshotStoreOptions): StateStore {
  const { root } = options;
  const fsTool = options.fsTool ?? createFsTool();
  const cycles: StateHash[] = [];
  let branchNonce = 0;

  async function read(hash: StateHash): Promise<Result<TaskManifest, RuntimeError>> {
    const text = await fsTool.readText(statePath(root, hash));
    if (text.isErr()) {
      return err(text.error);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text.value);
    } catch (error) {
      return err({ _tag: "FileSystemError", path: statePath(root, hash), message: String(error) });
    }
    return parseManifest(raw);
  }

  async function write(manifest: TaskManifest): Promise<Result<StateHash, RuntimeError>> {
    const hash = stateHash(manifest);
    const written = await fsTool.writeText(statePath(root, hash), `${JSON.stringify(manifest, null, 2)}\n`);
    if (written.isErr()) {
      return err(written.error);
    }
    return ok(hash);
  }

  return {
    async load(hash) {
      const target = hash ?? cycles.at(-1);
      if (target === undefined) {
        return err({ _tag: "FileSystemError", path: join(root, ".orca"), message: "no checkpoint to load" });
      }
      return read(target);
    },

    async checkpoint(state) {
      const validated = parseManifest(state);
      if (validated.isErr()) {
        return err(validated.error);
      }
      const written = await write(validated.value);
      if (written.isErr()) {
        return err(written.error);
      }
      cycles.push(written.value);
      return ok(written.value);
    },

    async branch(from) {
      const source = await read(from);
      if (source.isErr()) {
        return err(source.error);
      }
      const hash = createHash("sha256").update(`${from}:${String(branchNonce++)}`).digest("hex").slice(0, 12);
      const written = await fsTool.writeText(statePath(root, hash), `${JSON.stringify(source.value, null, 2)}\n`);
      if (written.isErr()) {
        return err(written.error);
      }
      return ok(hash);
    },

    async merge(branches, reducer: StateReducer<TaskManifest>) {
      const states: TaskManifest[] = [];
      for (const hash of branches) {
        const loaded = await read(hash);
        if (loaded.isErr()) {
          return err(loaded.error);
        }
        states.push(loaded.value);
      }
      return parseManifest(reducer(states));
    },

    history() {
      return Promise.resolve(ok([...cycles]));
    }
  };
}
