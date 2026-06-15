import type { Usage } from "../model/index.ts";

export interface FingerprintAction {
  readonly identity: string;
  readonly inputs: unknown;
}

export interface FingerprintDetectorOptions<T> {
  readonly project: (value: T) => FingerprintAction | undefined;
  /** Number of recent fingerprints retained for repeat detection. */
  readonly windowSize?: number;
  /** Repeated occurrences within the window required to declare stuck. */
  readonly repeatThreshold?: number;
}

export type TokenUsageSummary =
  | { readonly kind: "known"; readonly total: number; readonly budget?: number }
  | { readonly kind: "unknown"; readonly knownTotal: number; readonly budget?: number };

export function usageTokens(usage: Usage): number {
  return usage.input + usage.output + (usage.reasoning ?? 0);
}

export class TokenBudgetCounter {
  readonly #budget: number | undefined;
  #knownTotal = 0;
  #unknown = false;
  #knownRecords = 0;

  constructor(budget?: number) {
    this.#budget = budget;
  }

  record(usage: Usage | undefined): void {
    if (usage === undefined) {
      this.#unknown = true;
      return;
    }
    this.#knownRecords++;
    this.#knownTotal += usageTokens(usage);
  }

  get shouldReport(): boolean {
    return this.#budget !== undefined || this.#knownRecords > 0;
  }

  get exhausted(): boolean {
    return this.#budget !== undefined && !this.#unknown && this.#knownTotal > this.#budget;
  }

  summary(): TokenUsageSummary {
    if (this.#unknown) {
      return withBudget({ kind: "unknown", knownTotal: this.#knownTotal }, this.#budget);
    }
    return withBudget({ kind: "known", total: this.#knownTotal }, this.#budget);
  }
}

export function makeFingerprintStuckDetector<T>(
  options: FingerprintDetectorOptions<T>
): (value: T) => boolean {
  const repeatThreshold = options.repeatThreshold ?? 2;
  const windowSize = Math.max(options.windowSize ?? 3, repeatThreshold);
  const window: string[] = [];
  const counts = new Map<string, number>();

  return (value: T): boolean => {
    const projected = options.project(value);
    if (projected === undefined) {
      return false;
    }

    const fingerprint = fingerprintAction(projected);
    window.push(fingerprint);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);

    if (window.length > windowSize) {
      const expired = window.shift();
      if (expired !== undefined) {
        const remaining = (counts.get(expired) ?? 1) - 1;
        if (remaining <= 0) {
          counts.delete(expired);
        } else {
          counts.set(expired, remaining);
        }
      }
    }

    return (counts.get(fingerprint) ?? 0) >= repeatThreshold;
  };
}

export function fingerprintAction(action: FingerprintAction): string {
  return fnv1a32(`${action.identity}\u0000${stableStringify(action.inputs)}`);
}

function withBudget<T extends { readonly kind: "known" | "unknown" }>(
  summary: T,
  budget: number | undefined
): T | (T & { readonly budget: number }) {
  if (budget === undefined) {
    return summary;
  }
  return { ...summary, budget };
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    case "bigint":
      return `${value.toString()}n`;
    case "undefined":
      return "undefined";
    case "symbol":
    case "function":
      return String(value);
    case "object":
      break;
  }

  const objectValue = value;
  if (seen.has(objectValue)) {
    return "[Circular]";
  }
  seen.add(objectValue);

  if (Array.isArray(objectValue)) {
    const serialized = `[${objectValue.map((item) => stableStringify(item, seen)).join(",")}]`;
    seen.delete(objectValue);
    return serialized;
  }

  const entries = Object.entries(objectValue).sort(([left], [right]) => left.localeCompare(right));
  const serialized = `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue, seen)}`)
    .join(",")}}`;
  seen.delete(objectValue);
  return serialized;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
