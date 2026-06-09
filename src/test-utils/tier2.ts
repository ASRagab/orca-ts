import { expect } from "bun:test";

export interface Tier2Golden {
  readonly commits: readonly string[];
  readonly planFiles: Readonly<Record<string, string>>;
  readonly terminal: readonly string[];
  readonly events: readonly unknown[];
}

export function assertTier2Golden(actual: Tier2Golden, expected: Tier2Golden): void {
  expect(actual).toEqual(expected);
}
