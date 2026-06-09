import type { Result } from "neverthrow";

export function orThrow<T, E>(result: Result<T, E>): T {
  if (result.isOk()) {
    return result.value;
  }

  const error = result.error;
  if (error instanceof Error) {
    throw error;
  }
  throw new Error(errorMessage(error), { cause: error });
}

function errorMessage(error: unknown): string {
  if (isTaggedError(error)) {
    return error._tag;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Result failed";
}

function isTaggedError(error: unknown): error is { readonly _tag: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
  );
}
