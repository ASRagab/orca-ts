/**
 * Field-level signature guard for Orcats documentation.
 *
 * The sibling gate `check-doc-symbols.ts` verifies enum/union *literal sets*
 * only (e.g. that the set of `RuntimeError` `_tag` values matches between docs
 * and `src/`). It does NOT verify field-level signatures, so a transcribed type
 * with a wrong or missing *field* passes that gate. During PR #26 this happened
 * for real: 4 `RuntimeError` variants were transcribed with missing fields,
 * caught only by manual spot-checking. For agent consumers a confidently-wrong
 * signature is worse than none.
 *
 * This gate treats the `dist/` declaration files (output of `build:types`) as
 * the single source of truth and compares field names + optional/required status
 * against the fenced `ts`/`typescript` blocks on the website reference pages. It
 * pairs discriminated unions by their `_tag`/`type` literal, so the Zod-inferred
 * `RuntimeError` (per-variant `z.ZodObject<{...}>` consts in the .d.ts) is
 * compared against the doc's clean union.
 *
 * Scope (deliberate): field name + optionality only. Deep type comparison
 * (`string` vs `number | null`, `readonly`, generic params, element types) is
 * NOT verified — a primitive/function alias (e.g. `StateHash = string`,
 * `StateReducer = (states) => S`) has no comparable fields and is reported as
 * "not verified" rather than `pass`, so the report never claims a check it did
 * not perform. A missing/extra field fails with a named diff; that satisfies the
 * acceptance criterion.
 *
 * Run: `bun run scripts/check-doc-signatures.ts` (requires a prior `build:types`
 * so `dist/` exists). Exits non-zero with a per-type diff on any mismatch.
 *
 * The pure extraction/comparison helpers are exported so the gate's own logic is
 * unit-tested in `tests/check-doc-signatures.test.ts` — a verification gate that
 * only ever sees happy-path (all-matching) docs could otherwise regress silently.
 */
import * as ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const WEB_REF = join(ROOT, "website", "src", "content", "docs", "reference");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function rel(path: string): string {
  return relative(ROOT, path);
}

// ---------------------------------------------------------------------------
// Normalized signature shapes. Field name -> optional (false = required).
// ---------------------------------------------------------------------------

export type Fields = Map<string, boolean>;

export type Sig =
  | { kind: "object"; fields: Fields }
  | { kind: "union"; discriminant: string; variants: Map<string, Fields> }
  | { kind: "unionRefs"; names: string[] }
  | { kind: "other" };

// ---------------------------------------------------------------------------
// TS AST helpers (raw compiler API — no Program/type-checker, parse only).
// ---------------------------------------------------------------------------

export function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Rightmost identifier of a (possibly qualified) entity name like `z.ZodOptional`. */
export function entityName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

/** True if `node` is a `TypeReference` whose rightmost name is `name` (e.g. `z.ZodOptional`). */
export function isTypeRefTo(node: ts.TypeNode, name: string): node is ts.TypeReferenceNode {
  return ts.isTypeReferenceNode(node) && entityName(node.typeName) === name;
}

/** Read a `PropertyName` as a plain string, or undefined for computed names. */
export function propName(n: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return undefined; // ComputedPropertyName / PrivateIdentifier — not used here.
}

/** Fields from an interface body or type literal: properties + methods, name -> optional. */
export function fieldsFromMembers(members: ts.NodeArray<ts.TypeElement>): Fields {
  const fields: Fields = new Map();
  for (const m of members) {
    if (ts.isPropertySignature(m) || ts.isMethodSignature(m)) {
      const name = propName(m.name);
      if (name !== undefined) fields.set(name, m.questionToken !== undefined);
    }
  }
  return fields;
}

/** Find a `_tag`/`type` discriminant on a doc-side type literal: its literal string value. */
export function findLiteralDiscriminant(lit: ts.TypeLiteralNode): { name: string; value: string } | undefined {
  for (const m of lit.members) {
    if (!ts.isPropertySignature(m)) continue;
    const nm = propName(m.name);
    if (nm !== "_tag" && nm !== "type") continue;
    const t = m.type;
    if (t && ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) {
      return { name: nm, value: t.literal.text };
    }
  }
  return undefined;
}

/** Normalize a type-alias RHS (or any type node) into a Sig. */
export function sigFromTypeNode(node: ts.TypeNode): Sig {
  if (ts.isTypeLiteralNode(node)) {
    return { kind: "object", fields: fieldsFromMembers(node.members) };
  }
  if (ts.isUnionTypeNode(node)) {
    const literalVariants: Array<{ tag: string; fields: Fields; discName: string }> = [];
    const refNames: string[] = [];
    let sawLiteral = false;
    let sawRef = false;
    let sawOther = false;
    for (const c of node.types) {
      if (ts.isTypeLiteralNode(c)) {
        sawLiteral = true;
        const disc = findLiteralDiscriminant(c);
        if (!disc) return { kind: "other" }; // literal without discriminant — can't pair
        literalVariants.push({ tag: disc.value, fields: fieldsFromMembers(c.members), discName: disc.name });
      } else if (ts.isTypeReferenceNode(c)) {
        sawRef = true;
        refNames.push(entityName(c.typeName));
      } else {
        sawOther = true;
      }
    }
    if (sawOther || (sawLiteral && sawRef)) return { kind: "other" }; // mixed union — out of scope
    if (sawLiteral) {
      const variants = new Map<string, Fields>();
      for (const v of literalVariants) variants.set(v.tag, v.fields);
      const discName = literalVariants[0]?.discName ?? "_tag";
      return { kind: "union", discriminant: discName, variants };
    }
    if (sawRef) return { kind: "unionRefs", names: refNames };
    return { kind: "other" };
  }
  return { kind: "other" };
}

// ---------------------------------------------------------------------------
// .d.ts extraction (source of truth).
// ---------------------------------------------------------------------------

function findInterface(src: ts.SourceFile, name: string): ts.InterfaceDeclaration | undefined {
  for (const stmt of src.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return stmt;
  }
  return undefined;
}

function findTypeAlias(src: ts.SourceFile, name: string): ts.TypeAliasDeclaration | undefined {
  for (const stmt of src.statements) {
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) return stmt;
  }
  return undefined;
}

/**
 * True iff the Zod wrapper chain makes the field optional in the inferred
 * *output* type. `z.infer<z.ZodOptional<T>>` is `field?: T`; `ZodNullable` and
 * `ZodDefault` do NOT add `?` (nullable => `T | null`, default => always
 * present). So a field is optional iff `ZodOptional` appears anywhere in the
 * wrapper chain — unwrap `ZodNullable`/`ZodDefault` to find it. This correctly
 * handles `z.ZodNullable<z.ZodOptional<...>>` (optional) which the naive
 * outermost-only check misclassified as required.
 */
function zodOptional(t: ts.TypeNode | undefined): boolean {
  if (!t || !ts.isTypeReferenceNode(t)) return false;
  const name = entityName(t.typeName);
  if (name === "ZodOptional") return true;
  if (name === "ZodNullable" || name === "ZodDefault") {
    return zodOptional(t.typeArguments?.[0]);
  }
  return false;
}

/** Fields from a `z.ZodObject<{...}>` type literal; optional iff the wrapper chain contains `z.ZodOptional`. */
export function fieldsFromZodObject(lit: ts.TypeLiteralNode): Fields {
  const fields: Fields = new Map();
  for (const m of lit.members) {
    if (!ts.isPropertySignature(m)) continue;
    const nm = propName(m.name);
    if (nm === undefined) continue;
    fields.set(nm, zodOptional(m.type));
  }
  return fields;
}

/** Read the `_tag: z.ZodLiteral<"X">` discriminant value from a ZodObject type literal. */
export function findZodDiscriminant(lit: ts.TypeLiteralNode): string | undefined {
  for (const m of lit.members) {
    if (!ts.isPropertySignature(m)) continue;
    if (propName(m.name) !== "_tag") continue;
    const t = m.type;
    if (t && isTypeRefTo(t, "ZodLiteral")) {
      const arg = t.typeArguments?.[0];
      if (arg && ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
        return arg.literal.text;
      }
    }
  }
  return undefined;
}

/**
 * Zod-inferred union (RuntimeError): enumerate top-level `export declare const
 * X: z.ZodObject<{...}>` whose object literal has a `_tag: z.ZodLiteral<"…">`
 * discriminant. No dependency on the `*ErrorSchema` naming — pairing is by tag.
 */
export function extractZodVariants(src: ts.SourceFile): Map<string, Fields> {
  const variants = new Map<string, Fields>();
  for (const stmt of src.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const decl = stmt.declarationList.declarations[0];
    if (!decl || !ts.isIdentifier(decl.name)) continue;
    const type = decl.type;
    if (!type || !isTypeRefTo(type, "ZodObject")) continue;
    const lit = type.typeArguments?.[0];
    if (!lit || !ts.isTypeLiteralNode(lit)) continue;
    const tag = findZodDiscriminant(lit);
    if (tag === undefined) continue; // not a variant of this union
    variants.set(tag, fieldsFromZodObject(lit));
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Doc extraction (website reference pages).
// ---------------------------------------------------------------------------

export interface DocOccurrence {
  file: string;
  sig: Sig;
}

/**
 * Extract fenced `ts`/`typescript` block bodies. The fence language must be
 * exactly `ts` or `typescript` (word-boundary anchored) so `tsx` blocks are NOT
 * matched, and `typescript` blocks (invisible to a bare `ts` prefix) are.
 */
export function extractDocBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /^```(?:ts|typescript)\b[^\n]*\n([\s\S]*?)\n```/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    if (body !== undefined) out.push(body);
  }
  return out;
}

/** Collect every declared `interface`/`type` signature across all reference pages. */
function buildDocIndex(files: string[]): Map<string, DocOccurrence[]> {
  const index = new Map<string, DocOccurrence[]>();
  for (const file of files) {
    let text: string;
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const body of extractDocBlocks(text)) {
      const src = parse(file, body);
      for (const stmt of src.statements) {
        let name: string;
        let sig: Sig;
        if (ts.isInterfaceDeclaration(stmt)) {
          name = stmt.name.text;
          sig = { kind: "object", fields: fieldsFromMembers(stmt.members) };
        } else if (ts.isTypeAliasDeclaration(stmt)) {
          name = stmt.name.text;
          sig = sigFromTypeNode(stmt.type);
        } else {
          continue;
        }
        const occ: DocOccurrence = { file, sig };
        const list = index.get(name);
        if (list) list.push(occ);
        else index.set(name, [occ]);
      }
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

export type TargetKind = "interface" | "typeAlias" | "zodUnion";

export interface Target {
  type: string;
  dts: string; // relative to dist/
  kind: TargetKind;
  /** true = registry target that must be documented; false = discovered, skip if absent. */
  required: boolean;
}

// Seed table from the plan (docs-remediation-followups.md §Follow-up 1).
export const targets: Target[] = [
  { type: "RuntimeError", dts: "model/schemas.d.ts", kind: "zodUnion", required: true },
  { type: "Outcome", dts: "conversation/conversation.d.ts", kind: "typeAlias", required: true },
  { type: "Conversation", dts: "conversation/conversation.d.ts", kind: "interface", required: true },
  { type: "LoopBuilder", dts: "loop/builder/types.d.ts", kind: "interface", required: true },
  { type: "LoopOutcome", dts: "loop/builder/types.d.ts", kind: "interface", required: true },
  { type: "LoopRunOptions", dts: "loop/builder/types.d.ts", kind: "interface", required: true },
  { type: "LoopRunError", dts: "loop/builder/types.d.ts", kind: "typeAlias", required: true },
  { type: "LoopCycleReport", dts: "loop/builder/types.d.ts", kind: "interface", required: true },
  { type: "StateStore", dts: "loop/state/port.d.ts", kind: "interface", required: true },
  { type: "StateHash", dts: "loop/state/port.d.ts", kind: "typeAlias", required: true },
  { type: "StateReducer", dts: "loop/state/port.d.ts", kind: "typeAlias", required: true },
  { type: "LlmBackend", dts: "backends/types.d.ts", kind: "interface", required: true },
  { type: "AutonomousRequest", dts: "backends/types.d.ts", kind: "interface", required: true },
  { type: "SelectedBackend", dts: "backends/select.d.ts", kind: "interface", required: true },
  // Discovered at impl time (plan §Registry last two rows): LlmTool + the tool
  // interfaces under tools/**, and WorkflowRunLog. These are checked when
  // documented; an undocumented discovered type is skipped with a note.
  { type: "LlmTool", dts: "backends/types.d.ts", kind: "interface", required: false },
  { type: "FsTool", dts: "tools/fs.d.ts", kind: "interface", required: false },
  { type: "GitTool", dts: "tools/git.d.ts", kind: "interface", required: false },
  { type: "GitHubTool", dts: "tools/github.d.ts", kind: "interface", required: false },
  { type: "LinearTool", dts: "tools/linear.d.ts", kind: "interface", required: false },
  { type: "CommandTool", dts: "tools/process.d.ts", kind: "interface", required: false },
  { type: "TerminalTool", dts: "tools/terminal.d.ts", kind: "interface", required: false },
  { type: "WorkflowRunLog", dts: "monitor/index.d.ts", kind: "interface", required: false },
];

// ---------------------------------------------------------------------------
// Comparison (exact field-set equality; subset/elision mode intentionally
// omitted — it shipped unused and untested, and can be re-added with tests when
// a page actually needs it).
// ---------------------------------------------------------------------------

export interface FieldDiff {
  extraInDoc: string[];
  missingFromDoc: string[];
  optionality: string[];
}

export function compareFields(truth: Fields, doc: Fields): FieldDiff {
  const diff: FieldDiff = { extraInDoc: [], missingFromDoc: [], optionality: [] };
  for (const [name, docOpt] of doc) {
    const truthOpt = truth.get(name);
    if (truthOpt === undefined) diff.extraInDoc.push(name);
    else if (truthOpt !== docOpt) diff.optionality.push(name);
  }
  for (const [name] of truth) {
    if (!doc.has(name)) diff.missingFromDoc.push(name);
  }
  return diff;
}

/** Diff lines for two field maps (a union variant, or an object). Empty = match. */
export function diffFieldLines(prefix: string, truth: Fields, doc: Fields): string[] {
  const d = compareFields(truth, doc);
  return [
    ...d.extraInDoc.map((f) => `+extraInDoc: ${prefix}${f}`),
    ...d.missingFromDoc.map((f) => `-missingFromDoc: ${prefix}${f}`),
    ...d.optionality.map((f) => `~optionality: ${prefix}${f}`),
  ];
}

/** Compare a truth Sig against a doc Sig. Returns diff lines; empty = match. */
export function compareSigs(truth: Sig, doc: Sig): string[] {
  if (truth.kind !== doc.kind) {
    return [`~kindMismatch: .d.ts is ${truth.kind}, doc is ${doc.kind}`];
  }
  // After the kind-equality guard `truth.kind === doc.kind` holds at runtime, but
  // TypeScript narrows only the variable tested (`truth`), not `doc`, so `doc` is
  // cast to the matching variant in each branch.
  switch (truth.kind) {
    case "object": {
      const docFields = (doc as { fields: Fields }).fields;
      return diffFieldLines("", truth.fields, docFields);
    }
    case "union": {
      const docU = doc as { discriminant: string; variants: Map<string, Fields> };
      const lines: string[] = [];
      if (truth.discriminant !== docU.discriminant) {
        lines.push(`~discriminant: .d.ts "${truth.discriminant}", doc "${docU.discriminant}"`);
      }
      for (const [tag] of truth.variants) {
        if (!docU.variants.has(tag)) lines.push(`-missingVariant: ${tag}`);
      }
      for (const [tag] of docU.variants) {
        if (!truth.variants.has(tag)) lines.push(`+extraVariant: ${tag}`);
      }
      for (const [tag, truthFields] of truth.variants) {
        const docFields = docU.variants.get(tag);
        if (!docFields) continue;
        lines.push(...diffFieldLines(`${tag}.`, truthFields, docFields));
      }
      return lines;
    }
    case "unionRefs": {
      const docNames = (doc as { names: string[] }).names;
      const truthSet = new Set(truth.names);
      const docSet = new Set(docNames);
      const lines: string[] = [];
      for (const n of docNames) if (!truthSet.has(n)) lines.push(`+extraInDoc: ${n}`);
      for (const n of truth.names) if (!docSet.has(n)) lines.push(`-missingFromDoc: ${n}`);
      return lines;
    }
    default:
      return []; // both "other" — no comparable structure (primitive/function alias).
  }
}

// ---------------------------------------------------------------------------
// Engine.
// ---------------------------------------------------------------------------

let failures = 0;
let unverified = 0;
const reports: string[] = [];

function pass(line: string): void {
  reports.push(`  ✓ ${line}`);
}
function skip(line: string): void {
  reports.push(`  · ${line}`);
}
function fail(name: string, detail: string): void {
  failures++;
  reports.push(`  ✗ ${name}\n${detail}`);
}

function sigSummary(sig: Sig): string {
  switch (sig.kind) {
    case "object":
      return `${sig.fields.size.toString()} field${sig.fields.size === 1 ? "" : "s"}`;
    case "union":
      return `${sig.variants.size.toString()} variant${sig.variants.size === 1 ? "" : "s"} (discriminant "${sig.discriminant}")`;
    case "unionRefs":
      return `${sig.names.length.toString()} member${sig.names.length === 1 ? "" : "s"}`;
    default:
      return "no comparable structure (primitive/function alias)";
  }
}

function extractTruth(target: Target): Sig | undefined {
  const path = join(DIST, target.dts);
  let text: string;
  try {
    text = read(path);
  } catch {
    throw new Error(`dist declaration not found: ${target.dts} (run \`bun run build:types\` first)`);
  }
  const src = parse(target.dts, text);
  if (target.kind === "zodUnion") {
    const variants = extractZodVariants(src);
    if (variants.size === 0) return undefined;
    return { kind: "union", discriminant: "_tag", variants };
  }
  if (target.kind === "interface") {
    const decl = findInterface(src, target.type);
    if (!decl) return undefined;
    return { kind: "object", fields: fieldsFromMembers(decl.members) };
  }
  const decl = findTypeAlias(src, target.type);
  if (!decl) return undefined;
  return sigFromTypeNode(decl.type);
}

function run(): void {
  // Build the doc index from every website reference page.
  let refFiles: string[];
  try {
    refFiles = readdirSync(WEB_REF)
      .filter((f: string) => f.endsWith(".md"))
      .map((f: string) => join(WEB_REF, f));
  } catch {
    throw new Error(`reference docs directory not found: ${rel(WEB_REF)}`);
  }
  const docIndex = buildDocIndex(refFiles);

  for (const target of targets) {
    let truth: Sig;
    try {
      const t = extractTruth(target);
      if (!t) {
        fail(target.type, `    could not find ${target.kind} "${target.type}" in ${target.dts} — registry is stale`);
        continue;
      }
      truth = t;
    } catch (e) {
      fail(target.type, `    ${(e as Error).message}`);
      continue;
    }

    const occurrences = docIndex.get(target.type) ?? [];

    if (occurrences.length === 0) {
      if (target.required) {
        fail(target.type, `    not documented on any reference page (expected in ${target.dts})`);
      } else {
        skip(`${target.type} — skipped: not documented on a reference page (discovered type)`);
      }
      continue;
    }

    // A primitive/function alias has no field set to compare (deep types are
    // out of scope). Report as not-verified rather than pass so the summary
    // never claims a check it did not perform.
    if (truth.kind === "other") {
      if (target.required) unverified++;
      skip(`${target.type} (${target.dts}) — not verified: ${sigSummary(truth)}`);
      continue;
    }

    let allMatch = true;
    const details: string[] = [];
    for (const occ of occurrences) {
      const lines = compareSigs(truth, occ.sig);
      if (lines.length > 0) {
        allMatch = false;
        details.push(`    ${rel(occ.file)}:\n${lines.map((l) => `      ${l}`).join("\n")}`);
      }
    }

    if (allMatch) {
      pass(`${target.type} (${target.dts}) — ${sigSummary(truth)} [${occurrences.length.toString()} doc occurrence${occurrences.length === 1 ? "" : "s"}]`);
    } else {
      fail(`${target.type} (${target.dts})`, details.join("\n"));
    }
  }
}

if (import.meta.main) {
  run();

  // ---------------------------------------------------------------------------
  // Report.
  // ---------------------------------------------------------------------------
  console.log("check-doc-signatures: verifying documented field signatures against dist/*.d.ts\n");
  console.log(reports.join("\n"));
  console.log("");

  if (failures > 0) {
    console.error(`\ncheck-doc-signatures: ${String(failures)} type(s) failed.`);
    process.exit(1);
  }
  const unverifiedNote =
    unverified > 0
      ? ` ${String(unverified)} required type(s) had no comparable structure and were not verified (primitive/function aliases).`
      : "";
  console.log(`check-doc-signatures: all comparable field signatures match dist/*.d.ts.${unverifiedNote}`);
}
