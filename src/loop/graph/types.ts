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

/**
 * A back-edge closes a cycle. `declared` distinguishes intentional loop back-edges —
 * first-class domain data the builder hands us (design D6) — from accidental cycles the
 * DFS discovers in the forward subgraph. `cycle` is the node path naming the loop, used
 * to name the offending cycle in build/lint errors. For a declared back-edge it runs
 * `to → … → from` (the forward path the back-edge closes); for an accidental one it is
 * the grey DFS-stack slice `to → … → from`.
 */
export interface BackEdge extends Edge {
  readonly declared: boolean;
  readonly cycle: readonly NodeId[];
}

/** Input to {@link analyzeGraph}: the node set, all edges, and which edges are declared loop back-edges. */
export interface GraphInput {
  readonly nodes: readonly NodeId[];
  readonly edges: readonly Edge[];
  /** Edges the builder declares as intentional loop back-edges; trusted, not rediscovered. */
  readonly declaredBackEdges: readonly Edge[];
}

/**
 * One-pass 3-color DFS output. `traversal` is the preorder visit sequence; `topoOrder` is a
 * valid topological order of the forward DAG (reverse postorder, back-edges removed);
 * `backEdges` holds both declared loop back-edges and discovered accidental cycles.
 */
export interface CycleReport {
  readonly traversal: readonly NodeId[];
  readonly topoOrder: readonly NodeId[];
  readonly backEdges: readonly BackEdge[];
}
