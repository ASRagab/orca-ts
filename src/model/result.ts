import type { Result } from "neverthrow";

export function orThrow<T, E>(result: Result<T, E>): T {
  if (result.isOk()) {
    return result.value;
  }

  throw result.error;
}
