import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("ADR matrix", () => {
  test("tracks ADR 0001 through 0015", async () => {
    const matrix = JSON.parse(
      await readFile(join(process.cwd(), "fixtures", "adr", "matrix.json"), "utf8")
    ) as Array<{ adr: string; acceptance: string }>;

    expect(matrix.map((entry) => entry.adr)).toEqual(
      Array.from({ length: 15 }, (_, index) => String(index + 1).padStart(4, "0"))
    );
    expect(matrix.every((entry) => entry.acceptance.length > 0)).toBe(true);
  });
});
