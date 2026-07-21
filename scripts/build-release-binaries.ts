import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runQuiet, type QuietProcResult } from "../src/tools/process.ts";
import { parseReleaseBuildOptions } from "./release-build-options.ts";

const options = parseReleaseBuildOptions(process.argv.slice(2));
const releaseDir = options.releaseDir;
if (options.replaceReleaseDir) {
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });
} else {
  await mkdir(releaseDir);
}

const checksums: string[] = [];
const assets: string[] = [];

for (const target of options.targets) {
  const asset = target.replace(/^bun-/, "orcats-");
  const outDir = join(releaseDir, asset);
  const outFile = join(outDir, "orcats");
  const tarball = join(releaseDir, `${asset}.tar.gz`);

  await mkdir(outDir, { recursive: true });
  await mustRun("bun", [
    "build",
    "src/cli/main.ts",
    "--compile",
    "--compile-autoload-package-json",
    `--target=${target}`,
    `--outfile=${outFile}`,
  ]);
  await mustRun("tar", ["-czf", tarball, "-C", outDir, "orcats"]);

  const hash = new Bun.CryptoHasher("sha256");
  hash.update(await readFile(tarball));
  checksums.push(`${hash.digest("hex")}  ${asset}.tar.gz`);
  assets.push(tarball);
}

await writeFile(join(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);

for (const asset of [...assets, join(releaseDir, "SHA256SUMS.txt")]) {
  console.log(asset);
}

async function mustRun(
  command: string,
  args: readonly string[],
): Promise<QuietProcResult> {
  const result = await runQuiet(command, args);
  if (result.isErr()) {
    throw new Error(
      `command failed: ${command} ${args.join(" ")}\n${JSON.stringify(result.error)}`,
    );
  }
  return result.value;
}
