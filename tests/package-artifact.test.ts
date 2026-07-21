import { expect, test } from "bun:test";
import * as packageArtifact from "../scripts/package-artifact.ts";

const manifest = {
  name: "@twelvehart/orcats",
  version: "0.3.0",
  filename: "twelvehart-orcats-0.3.0.tgz",
  files: [{ path: "package.json" }]
};

const parseNpmPackJson = Reflect.get(packageArtifact, "parseNpmPackJson") as
  | ((stdout: string) => unknown)
  | undefined;

test("parses npm 12 keyed-object pack JSON", () => {
  expect(parseNpmPackJson).toBeFunction();
  expect(parseNpmPackJson?.(JSON.stringify({ [manifest.name]: manifest }))).toEqual(manifest);
});

test("parses npm 11 array pack JSON", () => {
  expect(parseNpmPackJson).toBeFunction();
  expect(parseNpmPackJson?.(JSON.stringify([manifest]))).toEqual(manifest);
});
