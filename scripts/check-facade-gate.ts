// Facade gate (design D2) — PLACEHOLDER / non-enforcing skeleton.
//
// The loop engine is Effect-powered, but Effect must never leak into the public
// authoring surface. This gate asserts no Effect type appears in:
//   - the generated root runtime export declaration (dist/index.d.ts)
//   - the generated explicit loop export surface (dist/loop/index.d.ts)
//   - authored flow files used by examples/tests (examples/**/*.ts)
//   - authored workflow files (.orca/workflows/**/*.ts)
// Internal engine files under src/loop/engine/** MAY reference Effect and are NOT scanned.
//
// STATUS: foundation scaffold. `ENFORCING = false` => this always exits 0 (PASS) so L01
// can land before any engine/builder logic exists. L04 (tasks 3.4-3.5) flips `ENFORCING`
// to true, at which point the detection below becomes verify-blocking and this script is
// added to the `verify` chain.
//
// Usage: bun run scripts/check-facade-gate.ts   (alias: bun run check:facade-gate)
import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// L04 flips this to true (tasks 3.4-3.5).
const ENFORCING = false;

const root = process.cwd();

// Generated declarations to scan (built by `bun run build:types`).
const DECLARATION_TARGETS = [
  "dist/index.d.ts", // root runtime export (orca-ts)
  "dist/loop/index.d.ts", // explicit loop export surface (orca-ts/loop)
];

// Authored flow/workflow files to scan.
const SOURCE_GLOBS = ["examples/**/*.ts", ".orca/workflows/**/*.ts"];

// Effect leak signatures. Conservative for the skeleton; refined when L04 makes this enforce.
const EFFECT_REFERENCE = /(?:from\s+["']effect["']|import\(["']effect["']\)|\bEffect\.[A-Z]|\bEffect<)/;

interface Leak {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function scanFile(absPath: string, rel: string, leaks: Leak[]): void {
  const lines = readFileSync(absPath, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    if (EFFECT_REFERENCE.test(text)) {
      leaks.push({ file: rel, line: i + 1, text: text.trim() });
    }
  }
}

const leaks: Leak[] = [];
const scanned: string[] = [];
const missing: string[] = [];

for (const rel of DECLARATION_TARGETS) {
  const abs = resolve(root, rel);
  if (existsSync(abs)) {
    scanFile(abs, rel, leaks);
    scanned.push(rel);
  } else {
    missing.push(rel);
  }
}

for (const pattern of SOURCE_GLOBS) {
  for (const rel of new Glob(pattern).scanSync(root)) {
    scanFile(resolve(root, rel), rel, leaks);
    scanned.push(rel);
  }
}

if (missing.length > 0) {
  console.log(
    `facade-gate: ${String(missing.length)} declaration target(s) not built yet ` +
      `(run \`bun run build:types\`): ${missing.join(", ")}`,
  );
}

if (!ENFORCING) {
  console.log(
    `✓ facade gate: PLACEHOLDER (non-enforcing) — scanned ${String(scanned.length)} file(s), ` +
      `${String(leaks.length)} potential Effect reference(s) noted. ` +
      `L04 (task 3.4) makes this verify-blocking.`,
  );
  process.exit(0);
}

// --- Enforcing path (activated by L04) ---
if (leaks.length > 0) {
  console.error(`✖ facade gate: Effect type leaked into the public surface (${String(leaks.length)}):`);
  for (const leak of leaks) console.error(`  - ${leak.file}:${String(leak.line)}: ${leak.text}`);
  process.exit(1);
}

console.log(`✓ facade gate: clean (${String(scanned.length)} file(s) scanned).`);
