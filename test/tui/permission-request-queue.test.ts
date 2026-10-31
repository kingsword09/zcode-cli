import { expect, test } from "bun:test";
import { join } from "node:path";

import { runAutomatedTuiScenario } from "./harness/run-scenario.ts";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";
import { permissionRequestQueueScenario } from "./scenarios/permission-request-queue.ts";

test.skipIf(process.platform === "win32")(
  "concurrent permission requests remain interactive in FIFO order",
  async () => {
    await runAutomatedTuiScenario(permissionRequestQueueScenario);
  },
  25_000
);
