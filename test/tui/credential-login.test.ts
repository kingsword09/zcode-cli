import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

test("TUI login asks in place, supports cancellation and resumes the same command", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-login-recovery-" });
  await using session = TerminalSession.start({ command: [process.execPath, join(import.meta.dir, "fixtures/credential-login.ts")], workspace });
  const secretPath = join(workspace.home, ".zcode", "v2", "credential-secret");
  await session.waitForScreen("ready", /Login recovery scenario ready/u);
  await session.sendAndWait("/login bigmodel-coding-plan\r", "storage choice", /Use local encrypted storage/u);
  expect(await stat(secretPath).catch(() => undefined)).toBeUndefined();
  await session.sendAndWait("\x1b", "cancelled", /Login stopped without storing credentials/u);
  expect(await stat(secretPath).catch(() => undefined)).toBeUndefined();
  await session.sendAndWait("/login bigmodel-coding-plan\r", "storage choice again", /Use local encrypted storage/u);
  await session.sendAndWait("\r", "continued", /Login continued successfully/u);
  const original = await readFile(secretPath, "utf8");
  const checkpoint = session.historyCheckpoint();
  session.send("/login bigmodel-coding-plan\r");
  await session.waitForHistory("repeat login", /Login continued successfully/u, checkpoint);
  expect(session.historyText(checkpoint)).not.toContain("Use local encrypted storage");
  expect(await readFile(secretPath, "utf8")).toBe(original);
  expect(session.historyText()).not.toContain(original);
  await session.exit();
}, 20_000);

test.each(["y", "n", "eof"])("terminal login handles %s without an additional command", async answer => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-terminal-login-" });
  await using session = TerminalSession.start({ command: [Bun.which("node")!, join(import.meta.dir, "fixtures/credential-login-terminal.cjs")], workspace });
  await session.waitForHistory("consent", /\[y\/N\]/u);
  session.send(answer === "eof" ? "\x04" : `${answer}\r`);
  await session.waitForHistory("result", answer === "y" ? /LOGIN_CONTINUED/u : /LOGIN_CANCELLED/u);
  const secretPath = join(workspace.home, ".zcode", "v2", "credential-secret");
  expect(Boolean(await stat(secretPath).catch(() => undefined))).toBe(answer === "y");
  if (answer === "y") {
    const secret = await readFile(secretPath, "utf8");
    expect(session.historyText()).not.toContain(secret);
  }
}, 15_000);
