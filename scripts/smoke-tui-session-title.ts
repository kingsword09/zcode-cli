#!/usr/bin/env bun
// Verify terminal session-title lifecycle behavior through a real PTY.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, "test", "fixtures", "tui-session-title.ts");
const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-tui-session-title-"));
const decoder = new TextDecoder();
let output = "";
const terminal = new Bun.Terminal({
  cols: 110,
  rows: 40,
  name: "xterm-256color",
  data(_terminal, data) {
    output += decoder.decode(data, { stream: true });
  }
});

const child = Bun.spawn([process.execPath, fixture], {
  cwd: root,
  env: {
    ...process.env,
    CI: "1",
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    TERM: "xterm-256color",
    TERM_PROGRAM: "iTerm.app",
    ZCODE_TUI_LOGIN_CMD: "true"
  },
  terminal,
  stdout: "ignore",
  stderr: "ignore"
});

function plainText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function terminalTitles(value: string): string[] {
  return [...value.matchAll(/\x1b\]0;([^\x07]*)\x07/gu)].map((match) => match[1] ?? "");
}

function titlesSince(start: number): string[] {
  return terminalTitles(output.slice(start));
}

async function waitFor(label: string, pattern: RegExp, start = 0, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pattern.test(plainText(output.slice(start)))) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.\n${plainText(output).slice(-6_000)}`);
}

async function waitForTitle(label: string, title: string, start = 0, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (titlesSince(start).includes(title)) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}: ${title}\n${titlesSince(start).join("\n")}`);
}

function assertSingleIdleTitle(label: string, start: number, idleTitle: string, workingTitle: string): void {
  const titles = titlesSince(start);
  const idleCount = titles.filter((title) => title === idleTitle).length;
  if (!titles.includes(workingTitle)) {
    throw new Error(`${label} never emitted its working title.\n${titles.join("\n")}`);
  }
  if (idleCount !== 1 || titles.at(-1) !== idleTitle) {
    throw new Error(`${label} emitted an unexpected title sequence.\n${titles.join("\n")}`);
  }
}

const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
let failure: unknown;
let code = 1;
try {
  await waitFor("welcome screen", /ZCode/i);
  await waitFor("restored startup transcript", /Restored startup response\./i);
  await waitForTitle("startup restored title", "ZC | Restored startup prompt.");

  const ordinaryStart = output.length;
  terminal.write("ordinary prompt\r");
  await waitFor("ordinary response", /Echo: ordinary prompt/i, ordinaryStart);
  await waitForTitle("ordinary idle title", "ZC | Restored startup prompt.", ordinaryStart);
  await Bun.sleep(100);
  assertSingleIdleTitle(
    "ordinary turn",
    ordinaryStart,
    "ZC | Restored startup prompt.",
    "ZC | ⠋ working…"
  );

  const loginStart = output.length;
  terminal.write("/login\r");
  await waitFor(
    "login completion",
    /Login command finished, but no configured model access was found\./i,
    loginStart
  );
  await waitForTitle("login idle title", "ZC | Restored startup prompt.", loginStart);
  await Bun.sleep(100);
  assertSingleIdleTitle(
    "suspended login",
    loginStart,
    "ZC | Restored startup prompt.",
    "ZC | ⠋ signing in…"
  );

  const resumeStart = output.length;
  terminal.write("/resume fixture-session\r");
  await waitFor("resume response", /Resumed session fixture-session\./i, resumeStart);
  await waitForTitle("resumed session title", "ZC | Restored resumed prompt.", resumeStart);
  await Bun.sleep(100);
  const resumeTitles = titlesSince(resumeStart);
  const resumedIdleCount = resumeTitles.filter((title) => title === "ZC | Restored resumed prompt.").length;
  if (!resumeTitles.includes("")
    || resumedIdleCount !== 1
    || resumeTitles.at(-1) !== "ZC | Restored resumed prompt.") {
    throw new Error(`Resume did not clear and replace the terminal title.\n${resumeTitles.join("\n")}`);
  }

  terminal.write("/exit\r");
  code = await child.exited;
} catch (error) {
  failure = error;
  child.kill("SIGKILL");
}

clearTimeout(timeout);
if (code === 1 && child.exitCode !== null) code = child.exitCode;
if (!terminal.closed) terminal.close();
await rm(temporaryHome, { recursive: true, force: true });

if (failure) throw failure;
if (code !== 0) throw new Error(`Session-title smoke exited with ${code}.\n${plainText(output).slice(-6_000)}`);
console.log("PASS: terminal session-title lifecycle");
