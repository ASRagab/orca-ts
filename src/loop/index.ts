// Public loop surface — Effect-FREE by mandate (design D2). The Effect-powered engine
// under ./engine is intentionally NOT re-exported here; the facade gate enforces that no
// Effect type reaches this surface or the root runtime export. ./graph stays internal too.
export * from "./builder/index.ts";
export * from "./state/index.ts";
export * from "./io/index.ts";
export * from "./context/index.ts";
