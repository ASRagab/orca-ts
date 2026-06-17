---
title: Served Loops
description: Host a loop trigger and isolate each firing in a child process.
---

`defineLoop()` packages a source, sink, and one-shot runner:

```ts
import { defineLoop, manual, stdout } from "orca-ts";

export default defineLoop({
  name: "example",
  source: manual<void>(),
  sink: stdout(),
  onTrigger: async () => {
    // Run one loop firing here.
  }
});
```

Discovery is import-only. `orca loops` must not start a source, backend, or sink:

```bash
orca loops
```

Run one firing:

```bash
ORCA_LOOP_EVENT='{}' orca run example
```

Serve a trigger:

```bash
orca serve example
```

`orca serve` owns the trigger and spawns a child process per firing. One child crash does not take down the supervisor or sibling firings.

Built-in source kinds are `manual`, `cron`, `watch`, `webhook`, and `queue`. Built-in sink kinds are `pr`, `file`, `slack`, `queue`, and `stdout`.
