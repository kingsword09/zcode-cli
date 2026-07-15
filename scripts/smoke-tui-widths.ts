#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, "test", "fixtures", "tui-features.ts");

function plainText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1bP[^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/gu, "");
}

async function verifyWidth(
  width: number,
  colorFgBg: string,
  noColor = false,
  theme?: string
): Promise<void> {
  const temporaryHome = await mkdtemp(join(tmpdir(), `zcode-tui-width-${width}-`));
  const decoder = new TextDecoder();
  let output = "";
  const terminal = new Bun.Terminal({
    cols: width,
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
      COLORFGBG: colorFgBg,
      HOME: temporaryHome,
      NO_COLOR: noColor ? "1" : "",
      TERM: "xterm-256color",
      USERPROFILE: temporaryHome,
      ZCODE_TUI_TEST_THEME: theme ?? "auto",
      ZCODE_TUI_NOTIFICATION_METHOD: "none"
    },
    terminal
  });

  const waitFor = async (label: string, pattern: RegExp, start = 0): Promise<void> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10_000) {
      if (pattern.test(plainText(output.slice(start)))) return;
      if (child.exitCode !== null) break;
      await Bun.sleep(20);
    }
    throw new Error(`Width ${width}: timed out waiting for ${label}.\n${plainText(output).slice(-4_000)}`);
  };
  const sendAndWait = async (input: string, label: string, pattern: RegExp): Promise<void> => {
    const start = output.length;
    terminal.write(input);
    await waitFor(label, pattern, start);
  };

  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  let interactionError: unknown;
  try {
    await waitFor("welcome screen", /ZCode/iu);
    await sendAndWait("/status\r", "status dialog", /ZCode Status/iu);
    terminal.write("\r");
    await Bun.sleep(75);
    await sendAndWait("\x16", "attachment row", /\[Image #1\]/iu);
    await sendAndWait("\x1b[A", "attachment selection", /› \[Image #1\][\s\S]*Del/iu);
    await sendAndWait("\x1b[B", "attachment return", /Images · \[Image #1\]/iu);
    await sendAndWait("/attachments clear\r", "attachment clear", /Pending attachments cleared\./iu);
    await sendAndWait("review long plan\r", "plan dialog", /Ready to implement\?/iu);
    await sendAndWait("\x0f", "expanded plan", /Ctrl\+O[\s\S]*Esc return/iu);
    terminal.write("\x1b[6~");
    await Bun.sleep(25);
    terminal.write("\x1b");
    await Bun.sleep(25);
    await sendAndWait("\r", "approved plan", /Plan approval fixture complete: allow\./iu);
    terminal.write("\x03");
  } catch (error) {
    interactionError = error;
    child.kill("SIGKILL");
  }

  const code = await child.exited;
  clearTimeout(timeout);
  if (!terminal.closed) terminal.close();
  output += decoder.decode();
  await rm(temporaryHome, { recursive: true, force: true });
  if (interactionError) throw interactionError;
  const plain = plainText(output);
  if (code !== 0 || /exceeds terminal width/iu.test(plain)) {
    throw new Error(`Width ${width}: TUI exited with ${code}.\n${plain.slice(-4_000)}`);
  }
  if (!noColor && theme === "light") {
    if (!output.includes("\x1b[38;5;25m")) {
      throw new Error(`Width ${width}: explicit light theme was not applied.`);
    }
    if (!output.includes("\x1b[1;38;5;236m")) {
      throw new Error(`Width ${width}: strong text still relies on the terminal foreground.`);
    }
  }
  if (!noColor && theme === "dark" && !output.includes("\x1b[38;5;75m")) {
    throw new Error(`Width ${width}: explicit dark theme was not applied.`);
  }
}

await verifyWidth(40, "0;15", false, "dark");
await verifyWidth(60, "15;0", false, "light");
await verifyWidth(80, "invalid", true, "unsupported");
await verifyWidth(100, "0;15");

console.log("TUI width smoke passed at 40, 60, 80 and 100 columns.");
