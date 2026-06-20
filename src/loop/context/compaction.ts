import type { CompactionConfig } from "./types.ts";

// Aggressive-default staged context compaction (design D10; task 7.1). Once managed context is
// enabled, compaction runs by TOKEN PRESSURE — the "small windows = smart agents" principle: a
// tight working window forces sharper agent behaviour and cheaper turns. As pressure rises past the
// small working window, the same observation history is compacted in escalating stages, IN ORDER:
//
//   mask      → keep every observation record but drop its body to a short stub (cheapest, lowest
//               information loss): the agent still sees that the step happened.
//   prune     → discard the oldest stubs that no longer fit, keeping the newest history that does.
//   summarize → when even pruning would discard most of the record (wholesale loss), collapse the
//               whole history span into a single bounded summary observation instead of dropping it.
//
// Each stage is reached only when the previous one cannot bring the context back within the window,
// so the stages applied report the pressure tier. `compact` is a pure transform (no I/O); large
// individual outputs are kept out of context separately by the offload path (see ./offload.ts), so
// by the time observations reach here each one is already bounded.

/** ~4 chars per token — the same crude estimate used across the loop module (cf. fanout budgets). */
const CHARS_PER_TOKEN = 4;
/** The stub a masked observation's body collapses to; its own token cost is the mask floor. */
const MASK_PLACEHOLDER = "⟦masked⟧";
/** Bounded size of the single observation produced by the summarize stage. */
const SUMMARY_TOKEN_CAP = 48;
const SUMMARY_CHAR_CAP = SUMMARY_TOKEN_CAP * CHARS_PER_TOKEN;
/** If fitting the window would force pruning more than this fraction of history, summarize instead. */
const PRUNE_TO_SUMMARIZE_FRACTION = 0.5;

/** Token cost of one masked stub — the irreducible floor of the mask stage. */
const MASK_TOKENS = estimateTokens(MASK_PLACEHOLDER);

/**
 * Aggressive defaults applied once managed context is enabled (design D10): a small working window
 * and an aggressive offload threshold. Authors MAY raise these, but enabled context gets tight
 * defaults out of the box.
 */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  workingWindowTokens: 2000,
  offloadThresholdChars: 8000,
};

/** The escalating compaction stages, lowest pressure first. */
export type CompactionStage = "mask" | "prune" | "summarize";

/** One unit of loop context — a tool/step observation the agent may later read. */
export interface Observation {
  /** Stable identifier, preserved through masking so the record of the step survives. */
  readonly id: string;
  /** The observation body; what masking and summarization compress. */
  readonly content: string;
  /** Pinned observations (goal, manifest) are never compacted. */
  readonly pinned?: boolean;
  /** Precise token cost; defaults to a ~4-chars-per-token estimate of `content`. */
  readonly tokens?: number;
}

export interface CompactionResult {
  /** The compacted context: pinned, then the compacted history span, then the verbatim recent tail. */
  readonly observations: readonly Observation[];
  /** Stages applied, in order — empty when there was no pressure, up to all three under heavy load. */
  readonly stagesApplied: readonly CompactionStage[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

/** Crude token estimate from character length; shared so masking/summary budgets stay consistent. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function tokensOf(observation: Observation): number {
  return observation.tokens ?? estimateTokens(observation.content);
}

function totalTokens(observations: readonly Observation[]): number {
  return observations.reduce((sum, observation) => sum + tokensOf(observation), 0);
}

/**
 * Compact `observations` to fit the small working window, escalating mask → prune → summarize only
 * as far as the token pressure requires. Pure: returns a new context plus the stages it applied. The
 * result is kept within `config.workingWindowTokens` except when a single un-offloaded recent
 * observation alone exceeds the window — offload oversized outputs (see ./offload.ts) to avoid that.
 */
export function compact(
  observations: readonly Observation[],
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
): CompactionResult {
  const window = config.workingWindowTokens;
  const tokensBefore = totalTokens(observations);
  if (tokensBefore <= window) {
    // No pressure — nothing is touched.
    return { observations: [...observations], stagesApplied: [], tokensBefore, tokensAfter: tokensBefore };
  }

  const { pinned, recent, history } = partition(observations, window);
  const fixedTokens = totalTokens(pinned) + totalTokens(recent); // pinned + recent tail are never compacted

  // Stage 1 — MASK every history observation's body down to a stub.
  const masked = history.map(maskObservation);
  if (fixedTokens + totalTokens(masked) <= window) {
    return assemble(pinned, masked, recent, ["mask"], tokensBefore);
  }

  // Stage 2 — PRUNE the oldest stubs that no longer fit, keeping the newest that do — UNLESS that
  // would discard most of the history, which is wholesale loss better handled by summarization.
  const room = Math.max(0, window - fixedTokens);
  const keepCount = Math.min(masked.length, Math.floor(room / MASK_TOKENS));
  const dropCount = masked.length - keepCount;
  if (dropCount <= masked.length * PRUNE_TO_SUMMARIZE_FRACTION) {
    const pruned = masked.slice(masked.length - keepCount); // keep the newest survivors
    return assemble(pinned, pruned, recent, ["mask", "prune"], tokensBefore);
  }

  // Stage 3 — SUMMARIZE the whole history span into one bounded observation, preserving its gist
  // rather than dropping the majority of it. Guaranteed to fit: the recent tail reserves room for it.
  const summary = summarizeObservations(history);
  return assemble(pinned, [summary], recent, ["mask", "prune", "summarize"], tokensBefore);
}

/**
 * Split observations into the never-compacted pinned set, the verbatim recent tail that fills the
 * working window (newest first, reserving room for a terminal summary), and the older history span.
 * At least the single newest non-pinned observation is always kept verbatim.
 */
function partition(
  observations: readonly Observation[],
  window: number,
): { pinned: Observation[]; recent: Observation[]; history: Observation[] } {
  const pinned = observations.filter((observation) => observation.pinned === true);
  const flow = observations.filter((observation) => observation.pinned !== true); // chronological, oldest→newest
  const recentBudget = Math.max(0, window - totalTokens(pinned) - SUMMARY_TOKEN_CAP);

  const recent: Observation[] = [];
  let used = 0;
  for (let i = flow.length - 1; i >= 0; i--) {
    const observation = flow[i];
    if (observation === undefined) {
      continue;
    }
    const cost = tokensOf(observation);
    if (recent.length > 0 && used + cost > recentBudget) {
      break; // always keep the newest observation; stop once the tail would overflow the budget
    }
    recent.unshift(observation);
    used += cost;
  }

  const history = flow.slice(0, flow.length - recent.length);
  return { pinned, recent, history };
}

/** Drop an observation's body to a stub while preserving its identity (the step still happened). */
function maskObservation(observation: Observation): Observation {
  return { id: observation.id, content: MASK_PLACEHOLDER };
}

/** Collapse a history span into one bounded summary observation that names what it replaced. */
function summarizeObservations(history: readonly Observation[]): Observation {
  const ids = history.map((observation) => observation.id).join(", ");
  const full = `⟦summary of ${String(history.length)} earlier observations: ${ids}⟧`;
  const content = full.length > SUMMARY_CHAR_CAP ? `${full.slice(0, SUMMARY_CHAR_CAP - 1)}…` : full;
  return { id: "compaction-summary", content };
}

function assemble(
  pinned: readonly Observation[],
  historyReplacement: readonly Observation[],
  recent: readonly Observation[],
  stagesApplied: readonly CompactionStage[],
  tokensBefore: number,
): CompactionResult {
  const observations = [...pinned, ...historyReplacement, ...recent];
  return { observations, stagesApplied, tokensBefore, tokensAfter: totalTokens(observations) };
}
