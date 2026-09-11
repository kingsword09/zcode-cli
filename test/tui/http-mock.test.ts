import { test } from "bun:test";

import { runAutomatedTuiScenario } from "./harness/run-scenario.ts";
import { httpMockScenario } from "./scenarios/http-mock.ts";

test.skipIf(process.platform === "win32")(
  "fixture fetches are intercepted inside the TUI child process",
  async () => {
    await runAutomatedTuiScenario(httpMockScenario);
  },
  35_000
);
