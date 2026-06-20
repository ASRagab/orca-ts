import { describe, expect, test } from "bun:test";
import * as ts from "typescript";
import {
  compareFields,
  compareSigs,
  diffFieldLines,
  extractDocBlocks,
  extractZodVariants,
  fieldsFromZodObject,
  findZodDiscriminant,
  parse,
  sigFromTypeNode,
  type Fields,
  type Sig,
} from "../scripts/check-doc-signatures.ts";

function fields(entries: Array<[string, boolean]>): Fields {
  return new Map(entries);
}

/** Parse `type X = <rhs>;` and return the normalized Sig of its RHS. */
function sigOfType(rhs: string): Sig {
  const src = parse("x.ts", `type X = ${rhs};`);
  const stmt = src.statements[0];
  if (!stmt || !ts.isTypeAliasDeclaration(stmt)) throw new Error("bad fixture: expected a type alias");
  return sigFromTypeNode(stmt.type);
}

/** Find the first `z.ZodObject<{...}>` object-literal in a parsed fixture. */
function firstZodObjectLiteral(src: ts.SourceFile): ts.TypeLiteralNode {
  for (const stmt of src.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const decl = stmt.declarationList.declarations[0];
    if (!decl) continue;
    const type = decl.type;
    if (!type || !ts.isTypeReferenceNode(type)) continue;
    const lit = type.typeArguments?.[0];
    if (lit && ts.isTypeLiteralNode(lit)) return lit;
  }
  throw new Error("no z.ZodObject literal found in fixture");
}

/** Fields of a single-variant `export declare const S: z.ZodObject<{ _tag: z.ZodLiteral<"T">; ... }>;` fixture. */
function zodObjectFields(decl: string): Fields {
  const src = parse("schemas.d.ts", decl);
  const variant = extractZodVariants(src).get("T");
  return variant ?? fieldsFromZodObject(firstZodObjectLiteral(src));
}

describe("compareFields / diffFieldLines", () => {
  test("missing field -> -missingFromDoc", () => {
    const d = compareFields(fields([["a", false], ["b", false]]), fields([["a", false]]));
    expect(d.missingFromDoc).toEqual(["b"]);
    expect(d.extraInDoc).toEqual([]);
    expect(d.optionality).toEqual([]);
  });

  test("extra field -> +extraInDoc", () => {
    const d = compareFields(fields([["a", false]]), fields([["a", false], ["x", false]]));
    expect(d.extraInDoc).toEqual(["x"]);
    expect(d.missingFromDoc).toEqual([]);
  });

  test("optionality mismatch -> ~optionality", () => {
    const d = compareFields(fields([["a", false]]), fields([["a", true]]));
    expect(d.optionality).toEqual(["a"]);
  });

  test("diffFieldLines emits the prefixed diff lines", () => {
    const lines = diffFieldLines(
      "PushRejected.",
      fields([["_tag", false], ["remote", true], ["stderr", false]]),
      fields([["_tag", false], ["remote", false], ["bogus", false]]),
    );
    expect(lines).toContain("+extraInDoc: PushRejected.bogus");
    expect(lines).toContain("-missingFromDoc: PushRejected.stderr");
    expect(lines).toContain("~optionality: PushRejected.remote");
  });
});

describe("compareSigs", () => {
  test("object vs object matches", () => {
    const sig: Sig = { kind: "object", fields: fields([["a", false], ["b", true]]) };
    expect(compareSigs(sig, sig)).toEqual([]);
  });

  test("kindMismatch when shapes differ", () => {
    const truth: Sig = { kind: "object", fields: fields([["a", false]]) };
    const doc: Sig = { kind: "unionRefs", names: ["a"] };
    expect(compareSigs(truth, doc)).toEqual(["~kindMismatch: .d.ts is object, doc is unionRefs"]);
  });

  test("union: missing + extra variant and per-variant field diff", () => {
    const truth: Sig = {
      kind: "union",
      discriminant: "_tag",
      variants: new Map([
        ["A", fields([["x", false]])],
        ["B", fields([["y", false]])],
      ]),
    };
    const doc: Sig = {
      kind: "union",
      discriminant: "_tag",
      variants: new Map([
        ["A", fields([])],
        ["C", fields([["z", false]])],
      ]),
    };
    const lines = compareSigs(truth, doc);
    expect(lines).toContain("-missingVariant: B");
    expect(lines).toContain("+extraVariant: C");
    expect(lines).toContain("-missingFromDoc: A.x");
  });

  test("union: discriminant name mismatch is reported", () => {
    const truth: Sig = { kind: "union", discriminant: "_tag", variants: new Map([["A", fields([])]]) };
    const doc: Sig = { kind: "union", discriminant: "type", variants: new Map([["A", fields([])]]) };
    expect(compareSigs(truth, doc)).toContain('~discriminant: .d.ts "_tag", doc "type"');
  });

  test("unionRefs: name-set diff", () => {
    const truth: Sig = { kind: "unionRefs", names: ["RuntimeError", "TerminationContractError"] };
    const doc: Sig = { kind: "unionRefs", names: ["RuntimeError", "OtherError"] };
    const lines = compareSigs(truth, doc);
    expect(lines).toContain("+extraInDoc: OtherError");
    expect(lines).toContain("-missingFromDoc: TerminationContractError");
  });

  test("other vs other -> no diff (nothing comparable)", () => {
    const sig: Sig = { kind: "other" };
    expect(compareSigs(sig, sig)).toEqual([]);
  });
});

describe("sigFromTypeNode", () => {
  test("object literal: fields + optionality", () => {
    const sig = sigOfType(`{ a: string; b?: number }`);
    expect(sig).toEqual({ kind: "object", fields: fields([["a", false], ["b", true]]) });
  });

  test("discriminated union of literals", () => {
    const sig = sigOfType(`{ type: "success"; result: R } | { type: "failed"; error?: E }`);
    expect(sig.kind).toBe("union");
    if (sig.kind === "union") {
      expect(sig.discriminant).toBe("type");
      expect(sig.variants.get("success")).toEqual(fields([["type", false], ["result", false]]));
      expect(sig.variants.get("failed")).toEqual(fields([["type", false], ["error", true]]));
    }
  });

  test("union of named refs -> unionRefs", () => {
    const sig = sigOfType(`RuntimeError | TerminationContractError`);
    expect(sig).toEqual({ kind: "unionRefs", names: ["RuntimeError", "TerminationContractError"] });
  });

  test("primitive alias -> other", () => {
    expect(sigOfType(`string`)).toEqual({ kind: "other" });
  });

  test("function alias -> other", () => {
    expect(sigOfType(`(states: readonly S[]) => S`)).toEqual({ kind: "other" });
  });
});

describe("zod optionality (false-green regression guard)", () => {
  test("ZodOptional -> optional; plain ZodString -> required; ZodNullable -> required", () => {
    const f = zodObjectFields(
      `export declare const S: z.ZodObject<{ _tag: z.ZodLiteral<"T">; a: z.ZodString; b: z.ZodOptional<z.ZodString>; c: z.ZodNullable<z.ZodNumber> }>;`,
    );
    expect(f.get("a")).toBe(false);
    expect(f.get("b")).toBe(true);
    expect(f.get("c")).toBe(false); // nullable, not optional
  });

  test("ZodNullable<ZodOptional<...>> -> optional (the bug the naive outermost-only check missed)", () => {
    const f = zodObjectFields(
      `export declare const S: z.ZodObject<{ _tag: z.ZodLiteral<"T">; n: z.ZodNullable<z.ZodOptional<z.ZodNumber>> }>;`,
    );
    expect(f.get("n")).toBe(true);
  });

  test("ZodOptional<ZodNullable<...>> -> optional", () => {
    const f = zodObjectFields(
      `export declare const S: z.ZodObject<{ _tag: z.ZodLiteral<"T">; n: z.ZodOptional<z.ZodNullable<z.ZodNumber>> }>;`,
    );
    expect(f.get("n")).toBe(true);
  });

  test("ZodDefault (no ZodOptional) -> required (default fills it)", () => {
    const f = zodObjectFields(
      `export declare const S: z.ZodObject<{ _tag: z.ZodLiteral<"T">; d: z.ZodDefault<z.ZodNumber> }>;`,
    );
    expect(f.get("d")).toBe(false);
  });

  test("findZodDiscriminant reads the _tag literal", () => {
    const src = parse(
      "schemas.d.ts",
      `export declare const S: z.ZodObject<{ _tag: z.ZodLiteral<"PushRejected">; stderr: z.ZodString }>;`,
    );
    expect(findZodDiscriminant(firstZodObjectLiteral(src))).toBe("PushRejected");
  });
});

describe("extractDocBlocks", () => {
  test("captures ts and typescript fences, rejects tsx", () => {
    const md = [
      "```ts",
      "type A = { a: string };",
      "```",
      "```typescript",
      "type B = { b: string };",
      "```",
      "```tsx",
      "const C = 1;",
      "```",
    ].join("\n");
    const blocks = extractDocBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("type A");
    expect(blocks[1]).toContain("type B");
  });
});
