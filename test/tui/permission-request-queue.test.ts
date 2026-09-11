import { test } from "bun:test";

import { runAutomatedTuiScenario } from "./harness/run-scenario.ts";
import { permissionRequestQueueScenario } from "./scenarios/permission-request-queue.ts";

test.skipIf(process.platform === "win32")(
  "concurrent permission requests remain interactive in FIFO order",
  async () => {
    await runAutomatedTuiScenario(permissionRequestQueueScenario);
  },
  25_000
);
