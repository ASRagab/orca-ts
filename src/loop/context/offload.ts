import { createHash } from "node:crypto";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";

import type { RuntimeError } from "../../model/index.ts";
import { createFsTool, type FsTool } from "../../tools/index.ts";
import { DEFAULT_COMPACTION_CONFIG } from "./compaction.ts";
import type { OffloadPointer } from "./types.ts";

// Large-output offload (design D10; task 7.2). A tool/step output larger than the configured size is
// written in FULL to a scratch file under `<root>/.orca/scratch/`, and only a short pointer reference
// is injected into context in its place — keeping one big payload from blowing the working window.
// A later step resolves the pointer back to the full payload. Scratch files are content-addressed
// (sha256 of the payload), so identical outputs dedupe to one file and the path is deterministic.

export interface OffloadOptions {
  /** Working root; scratch payloads land under `<root>/.orca/scratch/`. */
  readonly root: string;
  /** Char length above which an output is offloaded; defaults to the aggressive D10 default. */
  readonly thresholdChars?: number;
  /** Injectable filesystem for tests; defaults to the real adapter. */
  readonly fsTool?: FsTool;
}

/**
 * What interception did to one output: either it stayed inline (under threshold), or its body was
 * offloaded and replaced by a short `ref` string plus the structured `pointer` to resolve later.
 */
export type OffloadOutcome =
  | { readonly offloaded: false; readonly content: string }
  | { readonly offloaded: true; readonly ref: string; readonly pointer: OffloadPointer };

export interface OffloadStore {
  /** Route one output: offload + return a pointer ref when oversized, otherwise pass it through. */
  intercept(output: string): Promise<Result<OffloadOutcome, RuntimeError>>;
  /** Resolve a pointer back to the full payload written at offload time. */
  resolve(pointer: OffloadPointer): Promise<Result<string, RuntimeError>>;
}

/** The short reference injected into context in place of an offloaded payload. */
export function offloadRef(pointer: OffloadPointer): string {
  return `⟦offloaded ${String(pointer.bytes)}B → ${offloadDisplayPath(pointer.path)}⟧`;
}

export function createOffloadStore(options: OffloadOptions): OffloadStore {
  const { root } = options;
  const threshold = options.thresholdChars ?? DEFAULT_COMPACTION_CONFIG.offloadThresholdChars;
  const fsTool = options.fsTool ?? createFsTool();

  return {
    async intercept(output) {
      if (output.length <= threshold) {
        return ok({ offloaded: false, content: output }); // small enough — leave it in context
      }
      const hash = createHash("sha256").update(output).digest("hex").slice(0, 16);
      const path = join(root, ".orca", "scratch", `offload-${hash}.txt`);
      const written = await fsTool.writeText(path, output, { mode: 0o600 });
      if (written.isErr()) {
        return err(written.error);
      }
      const pointer: OffloadPointer = { path, bytes: Buffer.byteLength(output, "utf8") };
      return ok({ offloaded: true, ref: offloadRef(pointer), pointer });
    },

    async resolve(pointer) {
      return fsTool.readText(pointer.path);
    },
  };
}

function offloadDisplayPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const marker = "/.orca/scratch/";
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) {
    return `.orca/scratch/${normalized.slice(index + marker.length)}`;
  }
  return normalized.split("/").at(-1) ?? "offload";
}
