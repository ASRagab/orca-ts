import { describe, expect, test } from "bun:test";

import { analyzeGraph, type GraphInput, type NodeId } from "../src/loop/graph/index.ts";
import { enforceTerminationContract } from "../src/loop/termination-contract.ts";

const edge = (from: NodeId, to: NodeId) => ({ from, to });

/** Narrow `xs[0]` without a non-null assertion (banned by strictTypeChecked). */
function first<T>(xs: readonly T[]): T {
  const [x] = xs;
  if (x === undefined) throw new Error("expected a non-empty array");
  return x;
}

/** Every forward (non-back) edge must place its source before its target in the topo order. */
function topoRespectsEdges(input: GraphInput, topo: readonly NodeId[]): boolean {
  const declared = new Set(input.declaredBackEdges.map((e) => `${e.from} ${e.to}`));
  const pos = new Map(topo.map((n, i) => [n, i]));
  return input.edges
    .filter((e) => !declared.has(`${e.from} ${e.to}`))
    .every((e) => (pos.get(e.from) ?? -1) < (pos.get(e.to) ?? -1));
}

describe("analyzeGraph — 3-color DFS (design D6)", () => {
  test("pure DAG: full traversal, valid topo order, no back-edges", () => {
    const input: GraphInput = {
      nodes: ["a", "b", "c", "d"],
      edges: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
      declaredBackEdges: []
    };
    const report = analyzeGraph(input);

    expect(report.backEdges).toEqual([]);
    expect([...report.traversal].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...report.topoOrder].sort()).toEqual(["a", "b", "c", "d"]);
    expect(topoRespectsEdges(input, report.topoOrder)).toBe(true);
  });

  test("declared loop back-edge is recorded first-class, not an accidental cycle", () => {
    const input: GraphInput = {
      nodes: ["reason", "act", "check"],
      edges: [edge("reason", "act"), edge("act", "check"), edge("check", "reason")],
      declaredBackEdges: [edge("check", "reason")]
    };
    const report = analyzeGraph(input);

    expect(report.backEdges).toHaveLength(1);
    const be = first(report.backEdges);
    expect(be).toMatchObject({ from: "check", to: "reason", declared: true });
    // cycle names the forward path the back-edge closes: reason → act → check
    expect(be.cycle).toEqual(["reason", "act", "check"]);
    // declared back-edge removed from the DAG → topo order over forward edges only
    expect(topoRespectsEdges(input, report.topoOrder)).toBe(true);
    expect([...report.topoOrder].sort()).toEqual(["act", "check", "reason"]);
  });

  test("undeclared cycle is discovered and reported as accidental", () => {
    const input: GraphInput = {
      nodes: ["a", "b", "c"],
      edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")],
      declaredBackEdges: []
    };
    const report = analyzeGraph(input);

    expect(report.backEdges).toHaveLength(1);
    const be = first(report.backEdges);
    expect(be).toMatchObject({ from: "c", to: "a", declared: false });
    expect(be.cycle).toEqual(["a", "b", "c", "a"]);
  });

  test("A→B→A oscillation is caught as an accidental cycle", () => {
    const report = analyzeGraph({
      nodes: ["a", "b"],
      edges: [edge("a", "b"), edge("b", "a")],
      declaredBackEdges: []
    });
    expect(report.backEdges).toEqual([
      { from: "b", to: "a", declared: false, cycle: ["a", "b", "a"] }
    ]);
  });

  test("declared loop and accidental cycle are recorded distinctly in one pass", () => {
    const input: GraphInput = {
      nodes: ["a", "b", "c", "d", "e"],
      edges: [
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "a"), // declared loop
        edge("d", "e"),
        edge("e", "d") // accidental
      ],
      declaredBackEdges: [edge("c", "a")]
    };
    const report = analyzeGraph(input);

    const declared = report.backEdges.filter((b) => b.declared);
    const accidental = report.backEdges.filter((b) => !b.declared);
    expect(declared).toHaveLength(1);
    expect(first(declared)).toMatchObject({ from: "c", to: "a" });
    expect(accidental).toHaveLength(1);
    expect(first(accidental)).toMatchObject({ from: "e", to: "d", cycle: ["d", "e", "d"] });
  });

  test("tens-of-nodes graph: traversal + topo order correct with one declared loop", () => {
    const n = 30;
    const nodes = Array.from({ length: n }, (_, i) => `n${String(i)}`);
    const edges = [
      ...nodes.slice(0, -1).map((from, i) => edge(from, `n${String(i + 1)}`)), // chain n0→…→n29
      edge("n2", "n10"), // forward cross edge (fan-out/fan-in into the chain)
      edge("n7", "n20"),
      edge("n29", "n5") // declared loop back-edge
    ];
    const input: GraphInput = { nodes, edges, declaredBackEdges: [edge("n29", "n5")] };
    const report = analyzeGraph(input);

    expect([...report.traversal].sort()).toEqual([...nodes].sort());
    expect(report.topoOrder).toHaveLength(n);
    expect([...report.topoOrder].sort()).toEqual([...nodes].sort());
    expect(topoRespectsEdges(input, report.topoOrder)).toBe(true);

    expect(report.backEdges).toHaveLength(1);
    const be = first(report.backEdges);
    expect(be).toMatchObject({ from: "n29", to: "n5", declared: true });
    expect(be.cycle.at(0)).toBe("n5");
    expect(be.cycle.at(-1)).toBe("n29");
  });
});

describe("enforceTerminationContract (design D3, task 4.5)", () => {
  const declaredLoop: GraphInput = {
    nodes: ["reason", "act", "check"],
    edges: [edge("reason", "act"), edge("act", "check"), edge("check", "reason")],
    declaredBackEdges: [edge("check", "reason")]
  };

  test("pure DAG passes (no cycles to guard)", () => {
    const report = analyzeGraph({
      nodes: ["a", "b"],
      edges: [edge("a", "b")],
      declaredBackEdges: []
    });
    const result = enforceTerminationContract(report, () => false);
    expect(result.isOk()).toBe(true);
  });

  test("declared back-edge with a variant passes", () => {
    const report = analyzeGraph(declaredLoop);
    const result = enforceTerminationContract(report, (node) => node === "reason");
    expect(result.isOk()).toBe(true);
  });

  test("unguarded declared back-edge is rejected with the cycle NAMED", () => {
    const report = analyzeGraph(declaredLoop);
    const result = enforceTerminationContract(report, () => false);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error._tag).toBe("TerminationContractViolated");
    expect(error.violations).toHaveLength(1);
    expect(first(error.violations).kind).toBe("unguarded-back-edge");
    // the cycle is named in the message, and the variant-less head is identified
    expect(error.message).toContain("reason → act → check → reason");
    expect(error.message).toContain('node "reason"');
  });

  test("accidental cycle is rejected regardless of the variant predicate", () => {
    const report = analyzeGraph({
      nodes: ["a", "b", "c"],
      edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")],
      declaredBackEdges: []
    });
    const result = enforceTerminationContract(report, () => true);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(first(error.violations).kind).toBe("accidental-cycle");
    expect(error.message).toContain("accidental cycle a → b → c → a");
  });

  test("collects every violation in one pass", () => {
    const report = analyzeGraph({
      nodes: ["a", "b", "c", "d", "e"],
      edges: [
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "a"), // declared, unguarded
        edge("d", "e"),
        edge("e", "d") // accidental
      ],
      declaredBackEdges: [edge("c", "a")]
    });
    const result = enforceTerminationContract(report, () => false);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.violations).toHaveLength(2);
    expect(error.violations.map((v) => v.kind).sort()).toEqual([
      "accidental-cycle",
      "unguarded-back-edge"
    ]);
  });
});
