import { defineLoop, err, loop, ok, stdout, times, watch, type WatchEvent } from "../src/index.ts";

interface CountState {
  readonly count: number;
}

const definition = defineLoop<Partial<WatchEvent> | undefined, string, CountState>({
  name: "watch-once",
  source: watch({ paths: ["."] }),
  sink: stdout<string>(),
  async onTrigger(event) {
    const result = await loop<CountState>("watch-once-cycle")
      .step("count-event", (state) => ({ count: state.count + 1 }))
      .until(times(1))
      .run({ count: 0 });

    if (result.isErr()) {
      return err(result.error);
    }

    const eventType = event?.eventType ?? "manual";
    const filename = event?.filename ?? "(unknown)";
    return ok({
      outcome: result.value,
      output: `handled ${eventType} for ${filename}`,
    });
  },
});

export default definition;
