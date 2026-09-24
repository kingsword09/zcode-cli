import { expect, test } from "bun:test";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

test("TUI streams and polls tool activity without rereading history, then refreshes completed/resumed usage", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-runtime-refresh-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/runtime-refresh.ts")], workspace
  });
  await session.waitForScreen("initial cache", /cache 80% hit/u);
  session.send("stream\r");
  await session.waitForHistory("stream finished", /Streaming completed/u);
  await session.waitForScreen("completed cache", /cache 60% hit/u);
  const entries = (await workspace.readRuntimeJournal()).trim().split("\n").map((line) => JSON.parse(line));
  for (const kind of ["text-deltas.finished", "tool-progress.finished"]) {
    const entry = entries.find((entry) => entry.kind === kind);
    expect(entry, kind).toBeDefined();
    expect(entry.detail.after, kind).toBe(entry.detail.before);
    if (kind === "text-deltas.finished") {
      // Allow scheduled activity polls on slow CI; the subscription must not
      // introduce the previous 80 ms query loop during presentation-only data.
      expect(entry.detail.projectionReads).toBeLessThanOrEqual(Math.ceil(entry.detail.elapsedMs / 1_000) + 1);
    }
  }
  await session.sendAndWait("/resume second\r", "resumed session", /Resumed second session/u);
  await session.waitForScreen("resumed cache", /cache 20% hit/u);
  await session.exit();
}, 20_000);
