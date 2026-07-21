import { join } from "node:path";

export const ReleaseTargets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

export type ReleaseTarget = (typeof ReleaseTargets)[number];

export interface ReleaseBuildOptions {
  readonly targets: readonly ReleaseTarget[];
  readonly releaseDir: string;
  readonly replaceReleaseDir: boolean;
}

const Usage =
  "smoke mode requires --only-target=<target> and --release-dir=<path>";

function isReleaseTarget(value: string): value is ReleaseTarget {
  return ReleaseTargets.includes(value as ReleaseTarget);
}

export function parseReleaseBuildOptions(
  args: readonly string[],
  defaultReleaseDir = join("dist", "release"),
): ReleaseBuildOptions {
  if (args.length === 0) {
    return {
      targets: ReleaseTargets,
      releaseDir: defaultReleaseDir,
      replaceReleaseDir: true,
    };
  }

  const values = new Map<"only-target" | "release-dir", string>();
  for (const arg of args) {
    const match = /^--(only-target|release-dir)=(.+)$/.exec(arg);
    const key = match?.[1];
    const value = match?.[2];
    if (
      (key !== "only-target" && key !== "release-dir") ||
      value === undefined ||
      values.has(key)
    ) {
      throw new Error(Usage);
    }
    values.set(key, value);
  }

  const target = values.get("only-target");
  const releaseDir = values.get("release-dir");
  if (values.size !== 2 || target === undefined || releaseDir === undefined) {
    throw new Error(Usage);
  }
  if (!isReleaseTarget(target)) {
    throw new Error(`unsupported release target: ${target}`);
  }

  return {
    targets: [target],
    releaseDir,
    replaceReleaseDir: false,
  };
}

export function releaseTargetForHost(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): ReleaseTarget {
  const candidate = `bun-${platform}-${arch}`;
  if (isReleaseTarget(candidate)) {
    return candidate;
  }
  throw new Error(`unsupported release smoke host: ${platform}/${arch}`);
}
