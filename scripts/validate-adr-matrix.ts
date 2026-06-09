import { readFile } from "node:fs/promises";
import { join } from "node:path";

type AdrDisposition = "ported" | "cut" | "deferred";

interface AdrEntry {
  adr: string;
  title: string;
  disposition: AdrDisposition;
  acceptance: string;
}

const matrix = JSON.parse(
  await readFile(join(process.cwd(), "fixtures", "adr", "matrix.json"), "utf8")
) as AdrEntry[];

const failures: string[] = [];
const expected = Array.from({ length: 15 }, (_, index) =>
  String(index + 1).padStart(4, "0")
);
const actual = new Set(matrix.map((entry) => entry.adr));

for (const adr of expected) {
  if (!actual.has(adr)) {
    failures.push(`ADR ${adr} is missing from disposition matrix`);
  }
}

for (const entry of matrix) {
  if (!entry.title) {
    failures.push(`ADR ${entry.adr} is missing title`);
  }
  if (!entry.acceptance) {
    failures.push(`ADR ${entry.adr} is missing acceptance`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
