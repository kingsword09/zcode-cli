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

test.skipIf(process.platform === "win32")(
  "terminal sessions report screen wait timeouts with diagnostics",
  async () => {
    await using workspace = await ScenarioWorkspace.create();
    await using session = TerminalSession.start({
      command: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
      workspace
    });

    await expect(session.waitForScreen("missing prompt", /never appears/u, 10))
      .rejects.toThrow(/Timed out waiting for missing prompt in terminal screen/iu);
  }
);

test.skipIf(process.platform === "win32")(
  "terminal sessions report history wait timeouts with diagnostics",
  async () => {
    await using workspace = await ScenarioWorkspace.create();
    await using session = TerminalSession.start({
      command: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
      workspace
    });

    await expect(session.waitForHistory("missing output", /never appears/u, 0, 10))
      .rejects.toThrow(/Timed out waiting for missing output in terminal history/iu);
  }
);

test.skipIf(process.platform === "win32")(
  "terminal sessions kill fixtures that do not exit in time",
  async () => {
    await using workspace = await ScenarioWorkspace.create();
    await using session = TerminalSession.start({
      command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      workspace
    });

    await expect(session.exit()).rejects.toThrow("did not exit within 2000ms");
    expect(session.journal.format()).toContain('timedOut":true');
  },
  5_000
);

test.skipIf(process.platform === "win32")(
  "terminal sessions expose snapshots, checkpoints, and resize events",
  async () => {
    await using workspace = await ScenarioWorkspace.create();
    await using session = TerminalSession.start({
      cols: 20,
      rows: 4,
      command: [
        process.execPath,
        "-e",
        "process.stdout.write('ready'); setTimeout(() => process.exit(0), 100)"
      ],
      workspace
    });

    await session.waitForHistory("fixture output", /ready/u, 0, 1_000);
    const checkpoint = session.historyCheckpoint();
    expect(session.historyText(checkpoint)).toBe("");

    session.resize(30, 6);
    await session.settle();
    expect(session.screenSnapshot()).toMatchObject({
      cols: 30,
      rows: 6,
      text: "ready"
    });
    expect(session.journal.entries().at(-1)).toMatchObject({
      channel: "terminal.resize",
      detail: { cols: 30, rows: 6 }
    });

    await session.exit();
  }
);
