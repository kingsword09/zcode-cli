import { expect, test } from "bun:test";

import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

test.skipIf(process.platform === "win32")(
  "terminal sessions reject a non-zero fixture exit",
  async () => {
    await using workspace = await ScenarioWorkspace.create();
    await using session = TerminalSession.start({
      command: [process.execPath, "-e", "process.exit(7)"],
      workspace
    });

    await expect(session.exit()).rejects.toThrow("TUI fixture exited with code 7");
    expect(session.journal.format()).toContain('terminal.exit {"exitCode":7,"timedOut":false}');
  }
);
