export type Verdict<A> =
  | { readonly kind: "proceed"; readonly value: A }
  | { readonly kind: "rejection"; readonly category: "question" | "critique" | "rebuff"; readonly body: string }
