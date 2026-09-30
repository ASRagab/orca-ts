import type { BackendTag, RuntimeError } from "./schemas.ts";

type RuntimeErrorArgs<Tag extends RuntimeError["_tag"]> = Omit<
  Extract<RuntimeError, { _tag: Tag }>,
  "_tag"
>;

export function unsupportedFeature(feature: string, reason: string): RuntimeError {
  return { _tag: "UnsupportedFeature", feature, reason };
}

export interface BackendFailureContext {
  readonly transport?: string;
  readonly phase?: string;
  readonly artifactPath?: string;
  readonly recovery?: string;
}

export function backendFailed(
  backend: BackendTag,
  message: string,
  context: BackendFailureContext = {}
): RuntimeError {
  return { _tag: "BackendFailed", backend, message, ...context };
}

export function describeRuntimeError(error: unknown): string {
  if (isBackendFailure(error)) {
    const context = [
      error.transport === undefined ? undefined : `transport=${error.transport}`,
      error.phase === undefined ? undefined : `phase=${error.phase}`,
      error.artifactPath === undefined ? undefined : `artifact=${error.artifactPath}`,
    ].filter((item): item is string => item !== undefined);
    const details = context.length === 0 ? "" : ` (${context.join(", ")})`;
    const recovery = error.recovery === undefined ? "" : ` Recovery: ${error.recovery}`;
    return `${error.backend} backend failed${details}: ${error.message}.${recovery}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null &&
    "reason" in error && typeof error.reason === "string") {
    return error.reason;
  }
  try {
    const serialized = JSON.stringify(error) as string | undefined;
    return serialized ?? String(error);
  } catch {
    // JSON.stringify only throws on circular references or BigInt values.
    return typeof error === "bigint" ? error.toString() : "[unserializable value]";
  }
}

function isBackendFailure(error: unknown): error is Extract<RuntimeError, { _tag: "BackendFailed" }> {
  return typeof error === "object" && error !== null &&
    "_tag" in error && error._tag === "BackendFailed" &&
    "backend" in error && typeof error.backend === "string" &&
    "message" in error && typeof error.message === "string";
}

export function commandFailed(args: RuntimeErrorArgs<"CommandFailed">): RuntimeError {
  return { _tag: "CommandFailed", ...args };
}

export function structuredOutputValidationFailed(
  args: RuntimeErrorArgs<"StructuredOutputValidationFailed">
): RuntimeError {
  return { _tag: "StructuredOutputValidationFailed", ...args };
}

export function ioFailed(seam: "source" | "sink" | "tool", kind: string, message: string): RuntimeError {
  return { _tag: "IoFailed", seam, kind, message };
}
