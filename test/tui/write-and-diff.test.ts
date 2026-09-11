import { test } from "bun:test";

import { runAutomatedTuiScenario } from "./harness/run-scenario.ts";
import { writeAndDiffScenario } from "./scenarios/write-and-diff.ts";

test.skipIf(process.platform === "win32")(
  "isolated runtime writes render through the TUI real Git diff",
  async () => {
    await runAutomatedTuiScenario(writeAndDiffScenario);
  },
  25_000
);
