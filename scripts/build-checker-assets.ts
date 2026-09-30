import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const checkerRoot = join(root, "dist", "checker");
const modulesRoot = join(checkerRoot, "node_modules");
const orcatsRoot = join(modulesRoot, "@twelvehart", "orcats");

await rm(checkerRoot, { recursive: true, force: true });
await mkdir(join(orcatsRoot, "dist"), { recursive: true });

const declarations = new Bun.Glob("**/*.d.ts");
for await (const relative of declarations.scan({ cwd: join(root, "dist"), onlyFiles: true })) {
  if (relative.startsWith("checker/")) continue;
  const destination = join(orcatsRoot, "dist", relative);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(root, "dist", relative), destination);
}

await writeFile(
  join(orcatsRoot, "package.json"),
  JSON.stringify({
    name: "@twelvehart/orcats",
    type: "module",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts" },
      "./loop": { types: "./dist/loop/index.d.ts" },
      "./model": { types: "./dist/model/index.d.ts" }
    }
  }, null, 2) + "\n"
);

for (const dependency of ["typescript", "zod", "neverthrow", "effect"]) {
  const entry = Bun.resolveSync(dependency, root);
  const packageRoot = await findPackageRoot(entry);
  await cp(packageRoot, join(modulesRoot, dependency), { recursive: true });
}
for (const dependency of ["@types/bun", "@types/node", "bun-types", "undici-types"]) {
  await cp(join(root, "node_modules", dependency), join(modulesRoot, dependency), {
    recursive: true
  });
}

async function findPackageRoot(entry: string): Promise<string> {
  let current = dirname(entry);
  while (current !== dirname(current)) {
    if (await Bun.file(join(current, "package.json")).exists()) return current;
    current = dirname(current);
  }
  throw new Error(`package root not found for ${entry}`);
}
