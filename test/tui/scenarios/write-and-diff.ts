import { join } from "node:path";

import type { TuiScenario } from "./types.ts";

export const writeAndDiffScenario: TuiScenario = {
  name: "write-and-diff",
  description: "Writes isolated files and renders their real Git diff in the TUI.",
  fixture: join(import.meta.dir, "..", "fixtures", "write-and-diff.ts"),
  files: {
    "src/example.ts": "export const value = 1;\n"
  },
  async run(session, workspace) {
    await session.waitFor("scenario instructions", /Type “modify workspace” to start/i);
    await session.sendAndWait(
      "modify workspace\r",
      "mock Write completion",
      /Workspace write complete\./iu
    );
    if (await workspace.read("src/example.ts") !== "export const value = 2;\n") {
      throw new Error("The runtime fixture did not update the isolated workspace.");
    }
    await session.sendAndWait(
      "/diff\r",
      "diff source picker",
      /Select current workspace changes or a completed turn\./iu
    );
    await session.sendAndWait(
      "\r",
      "workspace diff files",
      /src\/created\.ts[\s\S]*src\/example\.ts/iu
    );
    await session.sendAndWait(
      "\x1b[B\r",
      "real Git diff detail",
      /Diff · src\/example\.ts[\s\S]*Page 1\/\d+/iu
    );
    if (!/export const value = 2;/u.test(session.text())) {
      throw new Error(`The TUI did not render the updated line.\n${session.text().slice(-4_000)}`);
    }
    session.send("\x1b");
    await session.settle();
    session.send("\x1b");
    await session.settle();
    session.send("\x1b");
    await session.settle();
  }
};
