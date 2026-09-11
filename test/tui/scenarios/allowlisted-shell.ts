import { join } from "node:path";

import type { TuiScenario } from "./types.ts";

export const allowlistedShellScenario: TuiScenario = {
  name: "allowlisted-shell",
  description: "Runs an allowlisted just-bash command and renders its real Git diff.",
  fixture: join(import.meta.dir, "..", "fixtures", "allowlisted-shell.ts"),
  files: {
    "reports/shell.txt": "before\n"
  },
  async run(session, workspace) {
    await session.waitForScreen(
      "scenario instructions",
      /Type “run allowlisted shell” to execute a bounded just-bash command/iu,
      20_000
    );
    session.send("run allowlisted shell\r");
    await session.waitForScreen("shell permission", /ALLOWLISTED_SHELL_WRITE/iu);
    await session.sendAndWait(
      "\r",
      "shell completion",
      /Allowlisted shell complete: 2 lines\./iu
    );
    if (await workspace.read("reports/shell.txt") !== "alpha\nbeta\n") {
      throw new Error("The allowlisted shell did not write the expected workspace file.");
    }
    await session.sendAndWait(
      "/diff\r",
      "diff source picker",
      /Select current workspace changes or a completed turn\./iu
    );
    await session.sendAndWait(
      "\r",
      "allowlisted shell diff",
      /reports\/shell\.txt/iu
    );
    session.send("\x1b");
    await session.settle();
    session.send("\x1b");
    await session.settle();
  }
};
