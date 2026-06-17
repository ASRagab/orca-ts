import { defineLoop, err, loop, ok, stdout, times, watch, type WatchEvent } from "orca-ts";

interface CountState {
  readonly count: number;
}

const LOOP_NAME = "REPLACE_WITH_LOOP_NAME";
const WATCH_PATHS = ["REPLACE_WITH_WATCH_PATH"] as const;

const definition = defineLoop<WatchEvent | undefined, string, CountState>({
  name: LOOP_NAME,
  source: watch({ paths: WATCH_PATHS }),
  sink: stdout<string>(),
  async onTrigger(event) {
    const result = await loop<CountState>(`${LOOP_NAME}-cycle`)
      .step("handle-trigger", (state) => ({ count: state.count + 1 }))
      .until(times(1))
      .run({ count: 0 });

    if (result.isErr()) {
      return err(result.error);
    }

    const eventType = event?.eventType ?? "manual";
    const filename = event?.filename ?? "(none)";
    return ok({
      outcome: result.value,
      output: `${LOOP_NAME}: handled ${eventType} ${filename}`,
    });
  },
});

export default definition;
