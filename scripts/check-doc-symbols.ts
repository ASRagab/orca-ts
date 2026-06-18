/**
 * Mechanical correctness guard for orca-ts documentation.
 *
 * The docs remediation plan (docs-remediation-plan.md) hand-transcribes
 * TypeScript signatures and literal sets from `src/` into the website/`docs/`
 * pages. Hand transcription drifts. This script treats `src/` as the single
 * source of truth for the *drift-prone contractual literals* — enum/union
 * members, exit-code maps, accessor names, env vars — and asserts the
 * documentation pages document the same set. It catches the exact class of
 * error that broke the website's Linear coverage and source/sink kind lists.
 *
 * What it does NOT do: full method-signature comparison (docgen from
 * `dist/*.d.ts`). That is a larger pipeline explicitly deferred by the plan
 * (Section 7). This guard covers the literal/variant class, which is where the
 * plan concentrates its risk.
 *
 * Run: `bun run scripts/check-doc-symbols.ts`
 * Exits non-zero with a per-contract diff on any mismatch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const DOCS = join(ROOT, "docs");
const WEB = join(ROOT, "website", "src", "content", "docs");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Extract every `"literal"` (or `'literal'`) from a span of source text. */
function literals(text: string): string[] {
  const out: string[] = [];
  const re = /["']([A-Za-z][A-Za-z0-9_-]*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = m[1];
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** Capture group 1 of every match of `re` in `text`, as a clean string[]. */
function cap1(re: RegExp, text: string): string[] {
  return [...text.matchAll(re)]
    .map((m) => m[1])
    .filter((v): v is string => v !== undefined);
}

/** Collect the contents of fenced code blocks and inline code spans. */
function codeSpansAndBlocks(text: string): string {
  const parts: string[] = [];
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const v = m[1];
    if (v !== undefined) parts.push(v);
  }
  const spanRe = /`([^`\n]+)`/g;
  while ((m = spanRe.exec(text)) !== null) {
    const v = m[1];
    if (v !== undefined) parts.push(v);
  }
  return parts.join("\n");
}

/**
 * Tokens a doc page documents: identifiers/dashed-names from code spans and
 * fenced blocks, plus quoted literals from anywhere. Constructors and
 * accessors are identifiers in code, not quoted strings, so reading code
 * spans is what lets "present" mode find them.
 */
function docTokens(text: string): string[] {
  const code = codeSpansAndBlocks(text);
  const tokens: string[] = [];
  const idRe = /[A-Za-z][A-Za-z0-9_-]*/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(code)) !== null) tokens.push(m[0]);
  for (const lit of literals(text)) tokens.push(lit);
  return tokens;
}

/** Capture the body of `export type Name = ...;` (union or otherwise). */
function typeBody(text: string, name: string): string {
  const re = new RegExp(`export\\s+type\\s+${name}\\s*=\\s*([\\s\\S]*?);`);
  const m = re.exec(text);
  if (!m) throw new Error(`could not find type ${name} in source`);
  return m[1] ?? "";
}

/** Read a `const Name = { k: v, ... } as const` object body and return its entries. */
function objectEntries(text: string, name: string): Array<[string, string]> {
  const re = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as\\s+const`);
  const m = re.exec(text);
  if (!m) throw new Error(`could not find object ${name} in source`);
  const body = m[1] ?? "";
  const entries: Array<[string, string]> = [];
  const entryRe = /([A-Za-z0-9_-]+)\s*:\s*(\d+)/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(body)) !== null) {
    if (em[1] !== undefined && em[2] !== undefined) entries.push([em[1], em[2]]);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Canonical sets — derived from src/, the single source of truth.
// ---------------------------------------------------------------------------

const schemas = read(join(SRC, "model", "schemas.ts"));
const errors = read(join(SRC, "model", "errors.ts"));
const monitor = read(join(SRC, "monitor", "index.ts"));
const builderTypes = read(join(SRC, "loop", "builder", "types.ts"));
const sourceIo = read(join(SRC, "loop", "io", "source.ts"));
const sinkIo = read(join(SRC, "loop", "io", "sink.ts"));
const serve = read(join(SRC, "loop", "serve.ts"));
const accessors = read(join(SRC, "flow", "accessors.ts"));
const reviewers = read(join(SRC, "review", "reviewers.ts"));
const select = read(join(SRC, "backends", "select.ts"));
const main = read(join(SRC, "cli", "main.ts"));
const persistent = read(join(SRC, "plan", "persistent.ts"));

// RuntimeError _tag variants: every `_tag: z.literal("X")` in schemas.ts.
const runtimeErrorTags = cap1(/_tag:\s*z\.literal\("([A-Za-z]+)"\)/g, schemas);

// RuntimeError constructors: exported function names in errors.ts.
const runtimeErrorCtors = cap1(/export function (\w+)\(/g, errors);

// Outcome verdict union.
const outcomeVerdicts = literals(typeBody(monitor, "OutcomeVerdict"));

// Loop stop-reason union.
const stopReasons = literals(typeBody(builderTypes, "LoopStopReason"));

// Stop-reason -> exit-code map.
const stopExitCodes = objectEntries(serve, "STOP_EXIT_CODES");

// Source / sink kind unions.
const sourceKinds = literals(typeBody(sourceIo, "SourceKind"));
const sinkKinds = literals(typeBody(sinkIo, "SinkKind"));

// FlowContext accessor function names.
const flowAccessors = cap1(/export function (\w+)\(/g, accessors);

// Backend tags (z.enum members).
const backendTags = [...schemas.matchAll(/BackendTagSchema\s*=\s*z\.enum\(\[([\s\S]*?)\]\)/g)]
  .flatMap((m) => literals(m[1] ?? ""))
  // filter to the four real tags (drops any stray quoted token)
  .filter((t) => ["claude", "codex", "opencode", "pi"].includes(t));

// Reviewer IDs and the default reviewer set.
const reviewerIds = [...reviewers.matchAll(/ReviewerIds\s*=\s*\[([\s\S]*?)\]/g)]
  .flatMap((m) => literals(m[1] ?? ""));
const defaultReviewers = [...reviewers.matchAll(/DefaultReviewers\s*=\s*\[([\s\S]*?)\]/g)]
  .flatMap((m) => literals(m[1] ?? ""));

// Env vars the docs must document. Canonical = present in src.
const envVars = [
  { name: "ORCA_BACKEND", inSrc: select.includes("ORCA_BACKEND") },
  { name: "ORCA_LOOP_EVENT", inSrc: main.includes("ORCA_LOOP_EVENT") },
  { name: "ORCA_DEP_LOOP_COLLAPSE", inSrc: persistent.includes("ORCA_DEP_LOOP_COLLAPSE") },
];

// ---------------------------------------------------------------------------
// Contract registry. Each contract maps a canonical (src-derived) set to the
// doc files that must reflect it, plus a comparison mode.
//   present — every canonical member must appear across the doc files.
//   exact   — the documented set (single explicit list) must equal canonical.
// ---------------------------------------------------------------------------

interface Contract {
  name: string;
  canonical: string[];
  docFiles: string[];
  mode: "present" | "exact";
  /** For exact mode: a regex whose capture group 1 is the documented list. */
  listPattern?: RegExp;
  hint?: string;
}

const webRef = (f: string) => join(WEB, "reference", f);
const webGuide = (f: string) => join(WEB, "guides", f);

const contracts: Contract[] = [
  {
    name: "RuntimeError _tag variants",
    canonical: runtimeErrorTags,
    docFiles: [webRef("runtime-errors.md")],
    mode: "present",
    hint: "Every RuntimeError _tag variant must be documented on the runtime-errors reference page.",
  },
  {
    name: "RuntimeError constructors",
    canonical: runtimeErrorCtors,
    docFiles: [webRef("runtime-errors.md")],
    mode: "present",
    hint: "Every RuntimeError constructor function must be documented.",
  },
  {
    name: "Outcome verdict values",
    canonical: outcomeVerdicts,
    docFiles: [webGuide("monitoring-recovery.md")],
    mode: "present",
    hint: "Every OutcomeVerdict value must be documented in the monitoring guide.",
  },
  {
    name: "Loop stop reasons",
    canonical: stopReasons,
    docFiles: [webRef("loop-api.md")],
    mode: "present",
    hint: "Every LoopStopReason must be documented in the loop-api reference.",
  },
  {
    name: "Source kinds",
    canonical: sourceKinds,
    docFiles: [webRef("loop-api.md")],
    mode: "exact",
    listPattern: /Built-in source kinds:\s*([^\n]+)/,
    hint: "The 'Built-in source kinds:' list on the loop-api reference must match SourceKind exactly (incl. linear-issue/linear-agent).",
  },
  {
    name: "Sink kinds",
    canonical: sinkKinds,
    docFiles: [webRef("loop-api.md")],
    mode: "exact",
    listPattern: /Built-in sink kinds:\s*([^\n]+)/,
    hint: "The 'Built-in sink kinds:' list on the loop-api reference must match SinkKind exactly (incl. linear-issue/linear-agent).",
  },
  {
    name: "FlowContext accessors",
    canonical: flowAccessors,
    docFiles: [webRef("api.md"), webRef("tools.md")],
    mode: "present",
    hint: "Every FlowContext accessor (incl. llm) must be documented.",
  },
  {
    name: "Backend tags",
    canonical: backendTags,
    docFiles: [webRef("backends.md")],
    mode: "present",
    hint: "Every backend tag (claude/codex/opencode/pi) must be documented.",
  },
  {
    name: "Reviewer IDs",
    canonical: reviewerIds,
    docFiles: [join(DOCS, "review.md")],
    mode: "present",
    hint: "Every ReviewerId must be documented in docs/review.md.",
  },
  {
    name: "Default reviewers",
    canonical: defaultReviewers,
    docFiles: [join(DOCS, "review.md")],
    mode: "present",
    hint: "The DefaultReviewers set must be documented in docs/review.md.",
  },
  {
    name: "Environment variables",
    canonical: envVars.filter((e) => e.inSrc).map((e) => e.name),
    docFiles: [
      webRef("backends.md"),
      webRef("cli.md"),
      webGuide("served-loops.md"),
      join(DOCS, "plans.md"),
      join(DOCS, "review.md"),
    ],
    mode: "present",
    hint: "Every ORCA_* env var read in src must be documented somewhere.",
  },
];

// Exit-code map is a special exact-pair contract.
interface ExitCodeContract {
  name: string;
  canonical: Array<[string, string]>;
  docFiles: string[];
}
const exitCodeContract: ExitCodeContract = {
  name: "Stop-reason -> exit-code map",
  canonical: stopExitCodes,
  docFiles: [webRef("cli.md"), webRef("loop-api.md")],
};

// ---------------------------------------------------------------------------
// Check engine.
// ---------------------------------------------------------------------------

function dedupeSorted(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

function missing(canonical: string[], documented: string[]): string[] {
  const doc = new Set(documented);
  return canonical.filter((c) => !doc.has(c));
}

let failures = 0;
const reports: string[] = [];

function fail(name: string, detail: string) {
  failures++;
  reports.push(`  ✗ ${name}\n${detail}`);
}

function pass(name: string) {
  reports.push(`  ✓ ${name}`);
}

for (const c of contracts) {
  const docText = c.docFiles.map((f) => {
    try {
      return read(f);
    } catch {
      return "";
    }
  }).join("\n");

  if (c.mode === "present") {
    const documented = docTokens(docText);
    const miss = missing(c.canonical, documented);
    if (miss.length > 0) {
      fail(
        c.name,
        `    documented set is missing: ${dedupeSorted(miss).join(", ")}\n    ${c.hint ?? ""}`,
      );
    } else {
      pass(c.name);
    }
  } else {
    // exact: pull each explicit list line and compare.
    let allGood = true;
    const detail: string[] = [];
    for (const f of c.docFiles) {
      let text: string;
      try {
        text = read(f);
      } catch {
        continue;
      }
      const pattern = c.listPattern;
      if (!pattern) continue; // exact contract without a list pattern — skip
      const m = pattern.exec(text);
      if (!m) continue; // file doesn't carry this list line; skip silently
      const m1 = m[1];
      if (m1 === undefined) continue;
      const documented = cap1(/`([^`]+)`/g, m1);
      const canon = new Set(c.canonical);
      const doc = new Set(documented);
      const missingFromDoc = [...canon].filter((x) => !doc.has(x));
      const extraInDoc = [...doc].filter((x) => !canon.has(x));
      if (missingFromDoc.length > 0 || extraInDoc.length > 0) {
        allGood = false;
        detail.push(
          `    ${f.replace(ROOT + "/", "")}:\n` +
            (missingFromDoc.length ? `      missing: ${missingFromDoc.join(", ")}\n` : "") +
            (extraInDoc.length ? `      extra:   ${extraInDoc.join(", ")}\n` : ""),
        );
      }
    }
    if (allGood) pass(c.name);
    else fail(c.name, detail.join("") + `    ${c.hint ?? ""}`);
  }
}

// Exit-code map: each canonical reason→code pair must appear on one line together.
{
  const docText = exitCodeContract.docFiles
    .map((f) => {
      try {
        return read(f);
      } catch {
        return "";
      }
    })
    .join("\n");
  const detail: string[] = [];
  for (const [reason, code] of exitCodeContract.canonical) {
    // A line that contains both the reason (word-bounded) and the code
    // (word-bounded number). Tolerates tables, arrows, and backtick wrapping.
    const re = new RegExp(`^.*\\b${reason}\\b.*\\b${code}\\b.*$`, "m");
    if (!re.test(docText)) {
      detail.push(`    missing mapping: ${reason} -> ${code}`);
    }
  }
  if (detail.length) fail(exitCodeContract.name, detail.join("\n"));
  else pass(exitCodeContract.name);
}

// Sanity: confirm src extraction actually found something for each contract
// (guards against a broken regex silently passing an empty canonical set).
const sanityChecks: Array<[string, string[]]> = [
  ["RuntimeError _tag variants", runtimeErrorTags],
  ["Outcome verdict values", outcomeVerdicts],
  ["Loop stop reasons", stopReasons],
  ["Stop-reason exit codes", stopExitCodes.map((e) => e[0])],
  ["Source kinds", sourceKinds],
  ["Sink kinds", sinkKinds],
  ["FlowContext accessors", flowAccessors],
  ["Backend tags", backendTags],
  ["Reviewer IDs", reviewerIds],
];
for (const [name, set] of sanityChecks) {
  if (set.length === 0) {
    fail(`SANITY: ${name}`, "    src extraction returned an empty set — regex is broken");
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log("check-doc-symbols: verifying documented literal sets against src/\n");
console.log(reports.join("\n"));
console.log("");

if (failures > 0) {
  console.error(`\ncheck-doc-symbols: ${String(failures)} contract(s) failed.`);
  process.exit(1);
}
console.log("check-doc-symbols: all documented literal sets match src/.");
