import { test } from "bun:test";

import { runAutomatedTuiScenario } from "./harness/run-scenario.ts";
import { allowlistedShellScenario } from "./scenarios/allowlisted-shell.ts";

test.skipIf(process.platform === "win32")(
  "allowlisted shell writes render through the TUI real Git diff",
  async () => {
    await runAutomatedTuiScenario(allowlistedShellScenario);
  },
  35_000
);
