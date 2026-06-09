import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect } from "bun:test";

export async function readJsonFixture<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function assertExactJson(actual: unknown, expected: unknown): void {
  expect(isDeepStrictEqual(actual, expected)).toBe(true);
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, Object.keys(flattenKeys(value)).sort(), 2)}\n`;
}

function flattenKeys(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenKeys(item, keys);
    }
    return keys;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys[key] = true;
      flattenKeys(child, keys);
    }
  }

  return keys;
}
