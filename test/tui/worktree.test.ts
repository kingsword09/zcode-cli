import { expect, test } from "bun:test";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

const fixture = join(import.meta.dir, "fixtures/worktree.ts");

test("/new offers a Worktree and starts the next runtime in its directory", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-worktree-new-" });
  await using session = TerminalSession.start({ command: [process.execPath, fixture], workspace });
  await session.waitForScreen("TUI ready", /scenario\/model/u);
  await session.sendAndWait("/new\r", "new session choices", /New Worktree/u);
  await session.send("\x1b[B\r");
  await session.exit();

  const journal = await workspace.readRuntimeJournal();
  expect(journal).toContain('"kind":"create"');
  expect(journal).toContain('"kind":"restart"');
  expect(journal).toContain("/.zcode/worktrees/1a2b/");
});

test("/new can keep using the current checkout", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-worktree-current-" });
  await using session = TerminalSession.start({ command: [process.execPath, fixture], workspace });
  await session.waitForScreen("TUI ready", /scenario\/model/u);
  await session.sendAndWait("/new\r", "new session choices", /Current checkout/u);
  await session.sendAndWait("\r", "native new session command", /Native command handled/u);
  await session.exit();

  const journal = await workspace.readRuntimeJournal();
  expect(journal).toContain('"kind":"native-command","input":"/new"');
  expect(journal).not.toContain('"kind":"create"');
});

test("/worktree lists the managed Worktree and starts a session there", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-worktree-open-" });
  await using session = TerminalSession.start({ command: [process.execPath, fixture], workspace });
  await session.waitForScreen("TUI ready", /scenario\/model/u);
  await session.sendAndWait("/worktree\r", "managed Worktree picker", /Worktree 1a2b/u);
  await session.send("\r");
  await session.exit();

  const journal = await workspace.readRuntimeJournal();
  expect(journal).toContain('"kind":"restart"');
  expect(journal).toContain("/.zcode/worktrees/1a2b/");
});
