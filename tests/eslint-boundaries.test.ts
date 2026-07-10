import { expect, test } from "bun:test";
import { join } from "node:path";
import { ESLint } from "eslint";

const root = join(import.meta.dir, "..");
const eslint = new ESLint({ cwd: root });

async function boundaryRuleIds(source: string, filePath: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintText(source, { filePath: join(root, filePath) });
  return result?.messages.map((message) => message.ruleId) ?? [];
}

test("rejects disallowed direct-file dependency boundaries", async () => {
  expect(await boundaryRuleIds('import "../conversation/index.ts";', "src/model/index.ts")).toContain(
    "boundaries/dependencies",
  );
  expect(await boundaryRuleIds('import "../flow/index.ts";', "src/conversation/index.ts")).toContain(
    "boundaries/dependencies",
  );
});

test("allows permitted direct-file dependency boundaries", async () => {
  expect(await boundaryRuleIds('import "./backend.ts";', "src/model/index.ts")).not.toContain(
    "boundaries/dependencies",
  );
  expect(await boundaryRuleIds('import "../model/index.ts";', "src/conversation/index.ts")).not.toContain(
    "boundaries/dependencies",
  );
});
