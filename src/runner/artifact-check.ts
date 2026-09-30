import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import ts from "typescript";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";
import type { TypecheckResult } from "./typecheck.ts";

export interface ArtifactCheckOptions {
  readonly cwd?: string;
  readonly assetsRoot?: string;
}

export async function checkArtifact(
  artifact: string,
  options: ArtifactCheckOptions = {}
): Promise<Result<TypecheckResult, RuntimeError>> {
  const cwd = options.cwd ?? process.cwd();
  const source = resolve(cwd, artifact);
  const temp = await mkdtemp(join(tmpdir(), "orcats-check-"));

  try {
    const assets = locateAssets(options.assetsRoot);
    const modules = assets === undefined
      ? resolve(import.meta.dir, "..", "..", "node_modules")
      : join(assets, "node_modules");
    await symlink(modules, join(temp, "node_modules"), "dir");

    const sourceRoot = resolve(import.meta.dir, "..", "..");
    const compilerOptions: ts.CompilerOptions = {
      allowImportingTsExtensions: true,
      exactOptionalPropertyTypes: true,
      lib: ["lib.es2023.d.ts"],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
      typeRoots: [join(modules, "@types")],
      types: ["bun"],
      verbatimModuleSyntax: true,
      baseUrl: temp,
      paths: {
        "@twelvehart/orcats": [assets === undefined
          ? join(sourceRoot, "src", "index.ts")
          : join(modules, "@twelvehart", "orcats", "dist", "index.d.ts")],
        "@twelvehart/orcats/loop": [assets === undefined
          ? join(sourceRoot, "src", "loop", "index.ts")
          : join(modules, "@twelvehart", "orcats", "dist", "loop", "index.d.ts")],
        "@twelvehart/orcats/model": [assets === undefined
          ? join(sourceRoot, "src", "model", "index.ts")
          : join(modules, "@twelvehart", "orcats", "dist", "model", "index.d.ts")]
      }
    };

    await writeFile(
      join(temp, "tsconfig.json"),
      JSON.stringify({ compilerOptions }, null, 2) + "\n"
    );

    const program = ts.createProgram([source], compilerOptions);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      const stderr = ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => cwd,
        getNewLine: () => "\n"
      });
      return err({ _tag: "TypecheckFailed", stdout: "", stderr, exitCode: 1 });
    }

    return ok({ skipped: false, stdout: "", stderr: "" });
  } catch (error) {
    return err({
      _tag: "TypecheckFailed",
      stdout: "",
      stderr: `orcats check: ${error instanceof Error ? error.message : String(error)}\n`,
      exitCode: 1
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function locateAssets(explicit: string | undefined): string | undefined {
  for (const candidate of [
    explicit,
    process.env.ORCA_CHECKER_ASSETS,
    resolve(import.meta.dir, "..", "..", "dist", "checker"),
    join(dirname(process.execPath), "checker")
  ]) {
    if (candidate !== undefined && existsSync(join(candidate, "node_modules", "typescript"))) {
      return candidate;
    }
  }
  return undefined;
}
