import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJsonSchemas } from "../src/model/index.ts";

const outDir = join(process.cwd(), "fixtures", "canonical", "schemas");
await mkdir(outDir, { recursive: true });

for (const [name, schema] of Object.entries(canonicalJsonSchemas())) {
  await writeFile(join(outDir, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`);
}
