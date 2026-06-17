import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../../model/index.ts";
import { parseManifest, type TaskManifest } from "./manifest.ts";
import { stateHash } from "./snapshot.ts";
import type { StateHash, StateReducer, StateStore } from "./port.ts";

// `sqlite` is the escalate-for-durability adapter (design D4): per-step checkpoints
// to a single WAL file plus lease-based crash recovery — finer resume than
// `snapshot`, still no service and no install (bun:sqlite is built into Bun).
// LangGraph's `better-sqlite3` saver fails on Bun (native ABI mismatch), so this is
// hand-rolled directly on `bun:sqlite`. It implements the SAME `StateStore` port as
// `snapshot`: loop code targets the port, so selecting this adapter needs no change
// to a loop definition. State lives in three tables:
//   - `snapshots(hash, manifest)` — content-addressed manifest JSON (checkpoints AND
//     branch copies). Reuses `stateHash` so a manifest hashes identically across
//     adapters; `INSERT OR REPLACE` keeps equal manifests deduplicated.
//   - `history(seq, hash, created_at)` — the ordered cycle stream (time-travel). Only
//     `checkpoint` appends; `branch` copies do NOT, matching `snapshot` history.
//   - `lease(owner, heartbeat)` — a single advisory row for crash recovery, NOT a
//     write lock: content-addressed snapshots + append-only history make concurrent
//     writers safe-but-interleaved. A live foreign lease is refused at open; a stale
//     one (holder crashed) is reclaimed, and the per-step-committed history is resumed.
//
// Durability boundary: every `checkpoint` commits in its own transaction and folds
// the WAL into the main db (`wal_checkpoint`), so an interrupt loses at most the
// in-flight step — a fresh store on the same file recovers `history()`/`load()`.

const DEFAULT_LEASE_TTL_MS = 30_000;

const SCHEMA: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS snapshots (hash TEXT PRIMARY KEY, manifest TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, heartbeat INTEGER NOT NULL)"
];

export interface SqliteStoreOptions {
  /** Database file path; durability and crash recovery require a real file
   * (`:memory:` works but is lost on exit). */
  readonly path: string;
  /** Lease owner id for this runner; defaults to a random per-process id. */
  readonly owner?: string;
  /** A lease whose heartbeat is older than this many ms is treated as a crashed
   * holder and reclaimed on open. */
  readonly leaseTtlMs?: number;
  /** Injectable clock (ms epoch) for deterministic lease tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The `sqlite` adapter: a {@link StateStore} plus lease lifecycle controls. The
 * extra members are NOT part of the port — loop code targets `StateStore` and never
 * sees them, so swapping `snapshot` <-> `sqlite` needs no loop-definition change.
 */
export interface SqliteStore extends StateStore {
  /** This runner's lease owner id. */
  readonly owner: string;
  /** Refresh the lease heartbeat mid-step so a long step keeps its lease;
   * `err` once another runner has reclaimed a stale lease. */
  heartbeat(): Result<void, RuntimeError>;
  /** Release the lease and close the database (clean shutdown — not a crash). */
  close(): void;
}

interface ManifestRow {
  manifest: string;
}
interface HashRow {
  hash: string;
}
interface LeaseRow {
  owner: string;
  heartbeat: number;
}

function fsErr(path: string, message: string): RuntimeError {
  return { _tag: "FileSystemError", path, message };
}

export function createSqliteStore(options: SqliteStoreOptions): Result<SqliteStore, RuntimeError> {
  const { path } = options;
  const owner = options.owner ?? randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = options.now ?? Date.now;

  let db: Database;
  try {
    db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    for (const statement of SCHEMA) {
      db.run(statement);
    }
  } catch (error) {
    return err(fsErr(path, `failed to open sqlite state store: ${String(error)}`));
  }

  const readSnapshot = (hash: StateHash): Result<TaskManifest, RuntimeError> => {
    let row: ManifestRow | null;
    try {
      row = db.query<ManifestRow, [string]>("SELECT manifest FROM snapshots WHERE hash = ?").get(hash);
    } catch (error) {
      return err(fsErr(path, `failed to read snapshot ${hash}: ${String(error)}`));
    }
    if (row === null) {
      return err(fsErr(path, `no snapshot for hash ${hash}`));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(row.manifest);
    } catch (error) {
      return err(fsErr(path, `corrupt snapshot ${hash}: ${String(error)}`));
    }
    return parseManifest(raw);
  };

  const writeSnapshot = (hash: StateHash, manifest: TaskManifest): Result<void, RuntimeError> => {
    try {
      db.run("INSERT OR REPLACE INTO snapshots (hash, manifest) VALUES (?, ?)", [hash, JSON.stringify(manifest)]);
      return ok(undefined);
    } catch (error) {
      return err(fsErr(path, `failed to write snapshot ${hash}: ${String(error)}`));
    }
  };

  // Acquire the lease = the crash-recovery boundary. A fresh foreign lease means
  // another runner is live (refuse); a stale or self-owned lease is reclaimed.
  try {
    const current = db.query<LeaseRow, []>("SELECT owner, heartbeat FROM lease WHERE id = 1").get();
    const ts = now();
    if (current === null) {
      db.run("INSERT INTO lease (id, owner, heartbeat) VALUES (1, ?, ?)", [owner, ts]);
    } else if (current.owner !== owner && ts - current.heartbeat <= leaseTtlMs) {
      db.close();
      return err(fsErr(path, `state store leased by "${current.owner}"; another runner is active`));
    } else {
      db.run("UPDATE lease SET owner = ?, heartbeat = ? WHERE id = 1", [owner, ts]);
    }
  } catch (error) {
    db.close();
    return err(fsErr(path, `lease acquisition failed: ${String(error)}`));
  }

  const store: SqliteStore = {
    owner,

    load(hash) {
      if (hash !== undefined) {
        return Promise.resolve(readSnapshot(hash));
      }
      let row: HashRow | null;
      try {
        row = db.query<HashRow, []>("SELECT hash FROM history ORDER BY seq DESC LIMIT 1").get();
      } catch (error) {
        return Promise.resolve(err(fsErr(path, `failed to read history: ${String(error)}`)));
      }
      if (row === null) {
        return Promise.resolve(err(fsErr(path, "no checkpoint to load")));
      }
      return Promise.resolve(readSnapshot(row.hash));
    },

    checkpoint(state) {
      const validated = parseManifest(state);
      if (validated.isErr()) {
        return Promise.resolve(err(validated.error));
      }
      const manifest = validated.value;
      const hash = stateHash(manifest);
      try {
        // One transaction per step: snapshot + history row + lease heartbeat commit
        // atomically, so an interrupt never leaves a half-written cycle.
        const commit = db.transaction((m: TaskManifest, h: StateHash, ts: number) => {
          db.run("INSERT OR REPLACE INTO snapshots (hash, manifest) VALUES (?, ?)", [h, JSON.stringify(m)]);
          db.run("INSERT INTO history (hash, created_at) VALUES (?, ?)", [h, ts]);
          db.run("UPDATE lease SET heartbeat = ? WHERE id = 1 AND owner = ?", [ts, owner]);
        });
        commit(manifest, hash, now());
        db.run("PRAGMA wal_checkpoint(PASSIVE)");
      } catch (error) {
        return Promise.resolve(err(fsErr(path, `checkpoint failed: ${String(error)}`)));
      }
      return Promise.resolve(ok(hash));
    },

    branch(from) {
      const source = readSnapshot(from);
      if (source.isErr()) {
        return Promise.resolve(err(source.error));
      }
      // Synthetic (non-content) hash so the isolated branch copy gets its own identity
      // instead of colliding with `from` under content addressing.
      const hash = createHash("sha256").update(`${from}:${randomUUID()}`).digest("hex").slice(0, 12);
      const written = writeSnapshot(hash, source.value);
      if (written.isErr()) {
        return Promise.resolve(err(written.error));
      }
      return Promise.resolve(ok(hash));
    },

    merge(branches, reducer: StateReducer<TaskManifest>) {
      const states: TaskManifest[] = [];
      for (const hash of branches) {
        const loaded = readSnapshot(hash);
        if (loaded.isErr()) {
          return Promise.resolve(err(loaded.error));
        }
        states.push(loaded.value);
      }
      return Promise.resolve(parseManifest(reducer(states)));
    },

    history() {
      try {
        const rows = db.query<HashRow, []>("SELECT hash FROM history ORDER BY seq").all();
        return Promise.resolve(ok(rows.map((row) => row.hash)));
      } catch (error) {
        return Promise.resolve(err(fsErr(path, `failed to read history: ${String(error)}`)));
      }
    },

    heartbeat() {
      try {
        const result = db.run("UPDATE lease SET heartbeat = ? WHERE id = 1 AND owner = ?", [now(), owner]);
        if (result.changes === 0) {
          return err(fsErr(path, `lease lost by "${owner}"; another runner reclaimed the store`));
        }
        return ok(undefined);
      } catch (error) {
        return err(fsErr(path, `heartbeat failed: ${String(error)}`));
      }
    },

    close() {
      try {
        db.run("DELETE FROM lease WHERE id = 1 AND owner = ?", [owner]);
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // Best-effort lease release / WAL fold; closing the handle is what matters.
      }
      db.close();
    }
  };

  return ok(store);
}
