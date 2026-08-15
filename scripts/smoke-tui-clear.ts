#!/usr/bin/env bun
// Verify /cls clears the transcript locally and /clear is forwarded to the runtime.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, "test", "fixtures", "tui-clear.ts");
const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-tui-clear-"));
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
    TERM_PROGRAM: "iTerm.app"
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

async function waitFor(label: string, pattern: RegExp, start = 0, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pattern.test(plainText(output.slice(start)))) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.\n${plainText(output).slice(-6_000)}`);
}

const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
let failure: unknown;
try {
  await waitFor("welcome screen", /ZCode/i);
  await waitFor("restored transcript", /Restored startup response\./i);
  terminal.write("/clear\r");
  await waitFor("runtime /clear response", /Runtime handled \/clear as a new session\./i);
  await waitFor("restored transcript still visible", /Restored later response\./i);
  terminal.write("/cls\r");
  await Bun.sleep(400);
  // pi-tui repaints differentially; assert on the newest frame after the
  // post-/cls full repaint (requestRender(true)) rather than all output.
  const tail = plainText(output).slice(-12_000);
  const lastFrame = tail.slice(Math.max(tail.lastIndexOf("◈"), tail.lastIndexOf("ZCode")));
  if (/Restored (startup|later) (prompt|response)\./.test(lastFrame)) {
    throw new Error(`/cls did not clear the visible transcript:\n${lastFrame.slice(-2_000)}`);
  }
  console.log("PASS: /clear is forwarded to the runtime and /cls clears the transcript");
} catch (error) {
  failure = error;
} finally {
  clearTimeout(timeout);
  child.kill("SIGKILL");
  await rm(temporaryHome, { recursive: true, force: true });
  setTimeout(() => process.exit(failure ? 1 : 0), 50).unref();
}
if (failure) {
  console.error(failure instanceof Error ? failure.message : String(failure));
  process.exit(1);
}
