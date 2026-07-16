import { describe, expect, test } from "bun:test";
import {
  parseReleaseBuildOptions,
  releaseTargetForHost,
  ReleaseTargets,
} from "../scripts/release-build-options.ts";

describe("release build options", () => {
  test("no arguments preserve the four-target release", () => {
    const options = parseReleaseBuildOptions([], "dist/release-test");
    expect(options.targets).toEqual(ReleaseTargets);
    expect(options.releaseDir).toBe("dist/release-test");
    expect(options.replaceReleaseDir).toBe(true);
  });

  test("paired smoke arguments select one fresh directory", () => {
    const options = parseReleaseBuildOptions([
      "--only-target=bun-darwin-arm64",
      "--release-dir=/tmp/orcats-release-proof",
    ]);
    expect(options.targets).toEqual(["bun-darwin-arm64"]);
    expect(options.releaseDir).toBe("/tmp/orcats-release-proof");
    expect(options.replaceReleaseDir).toBe(false);
  });

  test("rejects partial smoke arguments", () => {
    for (const args of [
      ["--only-target=bun-darwin-arm64"],
      ["--release-dir=/tmp/orcats-release-proof"],
    ]) {
      expect(() => parseReleaseBuildOptions(args)).toThrow("smoke mode requires");
    }
  });

  test("rejects unknown, duplicate, empty, and unsupported arguments", () => {
    for (const args of [
      ["--wat=value", "--release-dir=/tmp/orcats-release-proof"],
      ["--only-target=bun-darwin-arm64", "--only-target=bun-linux-x64"],
      ["--release-dir=/tmp/a", "--release-dir=/tmp/b"],
      ["--only-target=", "--release-dir=/tmp/orcats-release-proof"],
      ["--only-target=bun-windows-x64", "--release-dir=/tmp/orcats-release-proof"],
    ]) {
      expect(() => parseReleaseBuildOptions(args)).toThrow();
    }
  });

  test("maps supported hosts and rejects every other host", () => {
    expect(releaseTargetForHost("darwin", "arm64")).toBe("bun-darwin-arm64");
    expect(releaseTargetForHost("darwin", "x64")).toBe("bun-darwin-x64");
    expect(releaseTargetForHost("linux", "arm64")).toBe("bun-linux-arm64");
    expect(releaseTargetForHost("linux", "x64")).toBe("bun-linux-x64");
    expect(() => releaseTargetForHost("darwin", "ppc64")).toThrow(
      "unsupported release smoke host: darwin/ppc64",
    );
    expect(() => releaseTargetForHost("win32", "x64")).toThrow(
      "unsupported release smoke host: win32/x64",
    );
  });
});
