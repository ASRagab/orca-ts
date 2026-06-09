import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJsonSchemas } from "../src/model/index.ts";

const schemaDir = join(process.cwd(), "fixtures", "canonical", "schemas");
const failures: string[] = [];

for (const [name, schema] of Object.entries(canonicalJsonSchemas())) {
  const path = join(schemaDir, `${name}.json`);
  const expected = `${JSON.stringify(schema, null, 2)}\n`;
  let actual = "";

  try {
    actual = await readFile(path, "utf8");
  } catch {
    failures.push(`${path} is missing`);
    continue;
  }

  if (actual !== expected) {
    failures.push(`${path} differs from generated schema`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
