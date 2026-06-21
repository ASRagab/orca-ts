import {
  collectMetadataFailures,
  collectPackFailures,
  npmPackJson,
  readPackageJson
} from "./package-artifact.ts";

const failures = [
  ...collectMetadataFailures(readPackageJson()),
  ...collectPackFailures(npmPackJson(["--dry-run"]))
];

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
