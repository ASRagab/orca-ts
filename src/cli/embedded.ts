import { existsSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as root from "../index.ts";
import * as model from "../model/index.ts";

const EmbeddedKey = Symbol.for("orca-ts.embedded");
const PackageJson = JSON.stringify({
  name: "orca-ts",
  main: "index.cjs",
  exports: {
    ".": "./index.cjs",
    "./model": "./model.cjs"
  }
}, null, 2);

export function ensureOrcaResolvable(scriptPath: string): void {
  try {
    Bun.resolveSync("orca-ts", dirname(scriptPath));
    return;
  } catch {
    registerEmbeddedOrca(dirname(scriptPath));
  }
}

function registerEmbeddedOrca(scriptDir: string): void {
  Reflect.set(globalThis, EmbeddedKey, {
    root: { ...root },
    model: { ...model }
  });

  const nodeModulesDir = join(scriptDir, "node_modules");
  const packageDir = join(nodeModulesDir, "orca-ts");
  if (existsSync(packageDir)) {
    throw new Error(`orca: found ${packageDir} but could not resolve "orca-ts" from ${scriptDir}`);
  }

  const createdNodeModules = !existsSync(nodeModulesDir);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), `${PackageJson}\n`);
  writeFileSync(join(packageDir, "index.cjs"), embeddedModule("root"));
  writeFileSync(join(packageDir, "model.cjs"), embeddedModule("model"));
  scheduleCleanup(packageDir, nodeModulesDir, createdNodeModules);
}

function embeddedModule(name: "root" | "model"): string {
  return `const registry = globalThis[Symbol.for("orca-ts.embedded")];\nif (!registry) throw new Error("orca embedded library is not registered");\nmodule.exports = registry.${name};\n`;
}

function scheduleCleanup(packageDir: string, nodeModulesDir: string, createdNodeModules: boolean): void {
  let cleaned = false;
  process.once("exit", () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(packageDir, { recursive: true, force: true });
    if (createdNodeModules) {
      try {
        rmdirSync(nodeModulesDir);
      } catch {
        // Another process may have created a sibling package before exit.
      }
    }
  });
}
