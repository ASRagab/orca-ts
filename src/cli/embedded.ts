import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as root from "../index.ts";
import * as loop from "../loop/index.ts";
import * as model from "../model/index.ts";

const PackageName = "@twelvehart/orca-ts";
// One-release runtime alias for pre-0.1.0 standalone flows that import "orca-ts".
// The published package contract stays scoped; this shim is runtime-only.
const LegacyPackageName = "orca-ts";
const EmbeddedKey = Symbol.for("@twelvehart/orca-ts.embedded");
const RuntimeExports = {
  ".": "./index.cjs",
  "./loop": "./loop.cjs",
  "./model": "./model.cjs"
} as const;

interface EnsureOrcaResolvableOptions {
  readonly cleanup?: boolean;
}

export function ensureOrcaResolvable(scriptPath: string, options: EnsureOrcaResolvableOptions = {}): boolean {
  const scriptDir = dirname(scriptPath);
  registerEmbeddedRegistry();
  const includeSelfReference = isBunExecutable();
  const missingPackages = [PackageName, LegacyPackageName].filter(
    (specifier) => !hasProjectPackage(specifier, scriptDir, includeSelfReference)
  );
  if (missingPackages.length === 0) {
    scheduleExistingEmbeddedCleanup(scriptDir);
    return false;
  }
  registerEmbeddedOrca(scriptDir, missingPackages, options.cleanup ?? true);
  return true;
}

function hasProjectPackage(specifier: string, fromDir: string, includeSelfReference: boolean): boolean {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", ...specifier.split("/"), "package.json"))) {
      return true;
    }
    if (includeSelfReference && packageJsonName(join(dir, "package.json")) === specifier) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
  }
}

function isBunExecutable(): boolean {
  const bunPath = Bun.which("bun");
  if (bunPath === null) {
    return false;
  }
  try {
    return realpathSync(process.execPath) === realpathSync(bunPath);
  } catch {
    return process.execPath === bunPath;
  }
}

function packageJsonName(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function registerEmbeddedRegistry(): void {
  Reflect.set(globalThis, EmbeddedKey, {
    root: { ...root },
    loop: { ...loop },
    model: { ...model }
  });
}

function registerEmbeddedOrca(scriptDir: string, packageNames: readonly string[], cleanup: boolean): void {
  const nodeModulesDir = join(scriptDir, "node_modules");
  const createdNodeModules = !existsSync(nodeModulesDir);
  const packageDirs: string[] = [];
  const scopeDirs = new Set<string>();

  for (const packageName of packageNames) {
    const packageDir = join(nodeModulesDir, ...packageName.split("/"));
    if (existsSync(packageDir)) {
      throw new Error(`orca: found ${packageDir} but could not resolve "${packageName}" from ${scriptDir}`);
    }

    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), `${packageJson(packageName)}\n`);
    writeFileSync(join(packageDir, "index.cjs"), embeddedModule("root"));
    writeFileSync(join(packageDir, "loop.cjs"), embeddedModule("loop"));
    writeFileSync(join(packageDir, "model.cjs"), embeddedModule("model"));
    packageDirs.push(packageDir);

    if (packageName.startsWith("@")) {
      scopeDirs.add(join(nodeModulesDir, packageName.split("/")[0] ?? ""));
    }
  }

  if (cleanup) {
    scheduleCleanup(packageDirs, [...scopeDirs], nodeModulesDir, createdNodeModules);
  }
}

function packageJson(packageName: string): string {
  return JSON.stringify({
    name: packageName,
    orcaEmbedded: true,
    main: "index.cjs",
    exports: RuntimeExports
  }, null, 2);
}

function embeddedModule(name: "root" | "loop" | "model"): string {
  return `const registry = globalThis[Symbol.for("@twelvehart/orca-ts.embedded")];\nif (!registry) throw new Error("orca embedded library is not registered");\nmodule.exports = registry.${name};\n`;
}

function scheduleExistingEmbeddedCleanup(scriptDir: string): void {
  const nodeModulesDir = join(scriptDir, "node_modules");
  const packageDirs = [PackageName, LegacyPackageName]
    .map((packageName) => join(nodeModulesDir, ...packageName.split("/")))
    .filter(isEmbeddedPackageDir);
  if (packageDirs.length === 0) {
    return;
  }
  const scopeDirs = packageDirs
    .map((packageDir) => dirname(packageDir))
    .filter((scopeDir) => dirname(scopeDir) === nodeModulesDir);
  scheduleCleanup(packageDirs, scopeDirs, nodeModulesDir, true);
}

function isEmbeddedPackageDir(packageDir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      orcaEmbedded?: unknown;
    };
    return parsed.orcaEmbedded === true;
  } catch {
    return false;
  }
}

function scheduleCleanup(
  packageDirs: readonly string[],
  scopeDirs: readonly string[],
  nodeModulesDir: string,
  createdNodeModules: boolean
): void {
  let cleaned = false;
  process.once("exit", () => {
    if (cleaned) return;
    cleaned = true;
    for (const packageDir of packageDirs) {
      rmSync(packageDir, { recursive: true, force: true });
    }
    for (const scopeDir of scopeDirs) {
      try {
        rmdirSync(scopeDir);
      } catch {
        // Another scoped package may exist or have been created before exit.
      }
    }
    if (createdNodeModules) {
      try {
        rmdirSync(nodeModulesDir);
      } catch {
        // Another process may have created a sibling package before exit.
      }
    }
  });
}
