#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const runtime = join(root, "vendor", "zcode.cjs");
if (!existsSync(runtime)) throw new Error("vendor/zcode.cjs is missing; run `bun run sync:local` first.");

const decoder = new TextDecoder();
let output = "";
const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-cli-smoke-"));
const command = process.argv[2]
  ? [resolve(process.argv[2])]
  : [process.execPath, join(root, "bin", "zcode.ts")];
const terminal = new Bun.Terminal({
  cols: 100,
  rows: 32,
  name: "xterm-256color",
  data(_terminal, data) {
    output += decoder.decode(data, { stream: true });
  }
});

const child = Bun.spawn(command, {
  cwd: root,
  env: {
    ...process.env,
    CI: "1",
    HOME: temporaryHome,
    TERM: "xterm-256color"
  },
  terminal
});

const helpTimer = setTimeout(() => terminal.write("/help\r"), 800);
const modeTimer = setTimeout(() => terminal.write("/mode plan\r"), 2_600);
const exitTimer = setTimeout(() => terminal.write("/exit\r"), 5_000);
const timeout = setTimeout(() => {
  child.kill("SIGKILL");
}, 15_000);

const code = await child.exited;
clearTimeout(helpTimer);
clearTimeout(modeTimer);
clearTimeout(exitTimer);
clearTimeout(timeout);
if (!terminal.closed) terminal.close();
await rm(temporaryHome, { recursive: true, force: true });
output += decoder.decode();

const plain = output
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1bP[^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\r/g, "");

if (process.env.ZCODE_TUI_SMOKE_DEBUG === "1") console.log(plain);

if (code !== 0) throw new Error(`TUI smoke test exited with ${code}.\n${plain.slice(-4_000)}`);
if (!plain.includes("ZCode")) throw new Error(`TUI welcome screen was not rendered.\n${plain.slice(-4_000)}`);
if (!/Slash commands:|Usage:/i.test(plain)) {
  throw new Error(`The /help command did not render.\n${plain.slice(-4_000)}`);
}
if (!/mode switched to plan|current mode: plan|default · plan/i.test(plain)) {
  throw new Error(`The /mode command did not update the TUI.\n${plain.slice(-4_000)}`);
}

console.log("Bun.Terminal + pi-tui smoke test passed.");
