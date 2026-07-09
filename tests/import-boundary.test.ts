import { describe, expect, test } from "bun:test";
import * as sourceRoot from "../src/index.ts";
import * as sourceTesting from "../src/test-utils/index.ts";

const TestHelperExports = [
  "fakeBackend",
  "createFakeLlmTool",
  "eventRecorder",
  "assertTier2Golden",
  "readJsonFixture"
] as const;

const PackageRootSpecifier: string = "@twelvehart/orcats";
const PackageTestingSpecifier: string = "@twelvehart/orcats/testing";

describe("public import boundary", () => {
  test("root runtime entry does not export test helpers", async () => {
    const packageRoot = await import(PackageRootSpecifier) as Record<string, unknown>;
    for (const helper of TestHelperExports) {
      expect(helper in sourceRoot).toBe(false);
      expect(helper in packageRoot).toBe(false);
    }
  });

  test("explicit testing entries expose test helpers", async () => {
    const packageTesting = await import(PackageTestingSpecifier) as typeof sourceTesting;
    expect(typeof sourceTesting.fakeBackend).toBe("function");
    expect(typeof sourceTesting.assertTier2Golden).toBe("function");
    expect(typeof packageTesting.fakeBackend).toBe("function");
    expect(typeof packageTesting.assertTier2Golden).toBe("function");
  });
});
