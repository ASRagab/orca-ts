// Automatic, aggressive-default context management (design D10): staged compaction
// (mask -> prune -> summarize) by token pressure plus large-output offload to a
// scratch file with an injected pointer. Implemented in L08 (tasks 7.1-7.3).

/** Tunable thresholds; aggressive defaults apply with no author config (design D10). */
export interface CompactionConfig {
  /** Small working-memory window: token pressure above which staged compaction begins. */
  readonly workingWindowTokens: number;
  /** Char length above which an output is offloaded to a scratch file + pointer. */
  readonly offloadThresholdChars: number;
}

/** Pointer injected in place of an offloaded oversized output. TODO(L08, task 7.2). */
export interface OffloadPointer {
  readonly path: string;
  readonly bytes: number;
}
