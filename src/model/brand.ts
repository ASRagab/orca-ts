import type { BackendTag } from "./schemas.ts";

declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type SessionId<B extends BackendTag> = Brand<string, `SessionId:${B}`>;

export function sessionId<B extends BackendTag>(backend: B, value: string): SessionId<B> {
  void backend;
  return value as SessionId<B>;
}
