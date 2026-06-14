// Hand-built cycle-aware graph (design D6): a 3-color (white/grey/black) DFS giving
// cycle detection WITH the offending back-edge set, topological order, and traversal
// in one pass. No graph dependency. Implemented in L03 (tasks 4.3-4.5).
//
// Internal machinery: the loop() builder hides this, so it is intentionally NOT part
// of the public surface re-exported by ../index.ts.

export type NodeId = string;

export interface Edge {
  readonly from: NodeId;
  readonly to: NodeId;
}

/** Declared loop edges (first-class) are distinguished from accidental cycles (design D6). */
export interface BackEdge extends Edge {
  readonly declared: boolean;
}

/** 3-color DFS output: topological order plus the offending back-edge set. TODO(L03). */
export interface CycleReport {
  readonly topoOrder: readonly NodeId[];
  readonly backEdges: readonly BackEdge[];
}
