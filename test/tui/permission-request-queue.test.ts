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

for (const decision of ["allow", "deny"] as const) {
  test.skipIf(process.platform === "win32")(
    `queued permission settled by a hook (${decision}) preserves its tool result`,
    async () => {
      await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-permission-hook-" });
      await using session = TerminalSession.start({
        command: [process.execPath, join(import.meta.dir, "fixtures", "permission-request-hook.ts")],
        workspace
      });
      const terminalState = decision === "allow"
        ? /✓ Bash printf HOOK_TOOL/u
        : /✗ Bash printf HOOK_TOOL · failed/u;

      await session.waitForScreen("scenario instructions", /Type “hook allow” or “hook deny” to start\./u);
      await session.sendAndWait(`hook ${decision}\r`, "hook result while queued", /HOOK_SETTLED_WHILE_QUEUED/u);
      expect(session.screenText()).toMatch(terminalState);
      expect(session.screenText()).toContain("FIRST_ACTIVE_PERMISSION");
      await session.assertScreenExcludes("settled permission dialog", /HOOK_PERMISSION/u);

      await session.sendAndWait("1", "permission queue drained", /Hook race complete\./u);
      expect(session.screenText()).toMatch(terminalState);
      await session.assertScreenExcludes("stale tool state", /waiting for permission|interrupted/u);
      await session.assertScreenExcludes("settled permission dialog", /HOOK_PERMISSION/u);
      await session.sendAndWait("next prompt\r", "editor accepts the next prompt", /Follow-up received\./u);
      await session.exit();
    },
    25_000
  );
}
