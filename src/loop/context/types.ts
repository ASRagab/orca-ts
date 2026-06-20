// Opt-in managed context (design D10): once enabled, staged compaction
// (mask -> prune -> summarize) by token pressure plus large-output offload to a
// scratch file with an injected pointer run automatically during the cycle.

/** Tunable thresholds; aggressive defaults apply once managed context is enabled (design D10). */
export interface CompactionConfig {
  /** Small working-memory window: token pressure above which staged compaction begins. */
  readonly workingWindowTokens: number;
  /** Char length above which an output is offloaded to a scratch file + pointer. */
  readonly offloadThresholdChars: number;
}

/** Pointer to an offloaded oversized output; resolves back to the full payload (see ./offload.ts). */
export interface OffloadPointer {
  readonly path: string;
  readonly bytes: number;
}
