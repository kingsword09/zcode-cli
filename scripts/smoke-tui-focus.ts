#!/usr/bin/env bun

import { Terminal } from "@xterm/headless";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeTestEnv } from "./runtime-test-env.ts";

const root = join(import.meta.dir, "..");
const fixture = join(root, "test/fixtures/tui-focus.ts");
const mode = process.argv[2] ?? "fullscreen";
assert.ok(mode === "regular" || mode === "fullscreen", "Expected regular or fullscreen mode");
const notificationMethod = process.argv[3] ?? "off";
const notificationCondition = process.argv[4] ?? "always";
const entry = process.argv[5] ?? "source";
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const testHome = await mkdtemp(join(tmpdir(), "zcode-tui-focus-"));
const screen = new Terminal({ cols: 100, rows: 32, allowProposedApi: true });
let output = "";
let pending = Promise.resolve();
let cursorVisible = true;
for (const [final, visible] of [["h", true], ["l", false]] as const) {
  screen.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
    if (params.includes(25)) cursorVisible = visible;
    return false;
  });
}
const decoder = new TextDecoder();
const terminal = new Bun.Terminal({
  cols: screen.cols,
  rows: screen.rows,
  name: "xterm-256color",
  data(_terminal, data) {
    const chunk = decoder.decode(data, { stream: true });
    output += chunk;
    pending = pending.then(() => new Promise<void>((resolve) => screen.write(chunk, resolve)));
  }
});
const child = Bun.spawn([process.execPath, fixture, entry], {
  cwd: root,
  env: {
    ...runtimeTestEnv(testHome, root), CI: "1", NO_COLOR: "", TERM: "xterm-256color", SHELL: "/bin/sh",
    TERM_PROGRAM: "iTerm.app", ZCODE_TUI_MODE: mode,
    ZCODE_TUI_NOTIFICATION_METHOD: notificationMethod,
    ZCODE_TUI_NOTIFICATION_CONDITION: notificationCondition,
    ZCODE_TUI_LOGIN_CMD: `${shellQuote(process.execPath)} ${shellQuote(fixture)} login`
  },
  terminal
});
const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);

function screenText(): string {
  const buffer = screen.buffer.active;
  return Array.from({ length: screen.rows }, (_, row) => (
    buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ""
  )).join("\n");
}

function caretInverse(): boolean {
  const buffer = screen.buffer.active;
  return Boolean(buffer.getLine(buffer.baseY + buffer.cursorY)?.getCell(buffer.cursorX)?.isInverse());
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pending;
    if (condition()) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label} (${mode}, ${notificationMethod}/${notificationCondition}, exit=${child.exitCode}, bytes=${output.length}).\n${screenText()}`);
}

async function send(input: string): Promise<void> {
  terminal.write(input);
  await Bun.sleep(100);
  await pending;
}

async function focusCycle(label: string): Promise<void> {
  assert.equal(cursorVisible, true, `${label}: hardware cursor starts visible`);
  assert.equal(caretInverse(), true, `${label}: drawn caret starts visible`);
  const before = screenText();
  const position = { x: screen.buffer.active.cursorX, y: screen.buffer.active.cursorY };
  terminal.write("\x1b[O");
  await waitFor(`${label}: hardware and drawn carets hidden`, () => !cursorVisible && !caretInverse());
  assert.equal(screenText(), before, `${label}: hiding the caret preserves text`);
  await send("\x1b[O");
  assert.equal(cursorVisible, false, `${label}: repeated focus-out stays hidden`);
  assert.equal(caretInverse(), false, `${label}: repeated focus-out keeps the drawn caret hidden`);
  terminal.write("\x1b[I");
  await waitFor(`${label}: both carets restored`, () => cursorVisible && caretInverse());
  assert.equal(screenText(), before, `${label}: restoring the caret preserves text`);
  assert.deepEqual(
    { x: screen.buffer.active.cursorX, y: screen.buffer.active.cursorY },
    position,
    `${label}: focus changes preserve the cursor position for IME placement`
  );
}

async function editorReady(): Promise<void> {
  await waitFor("editor focus", () => cursorVisible && caretInverse() && screen.buffer.active.cursorY >= screen.rows - 5);
}

async function openPrompt(mask: boolean): Promise<void> {
  await send("\x1b[O");
  await send("/focus-prompt\r");
  await waitFor("prompt picker", () => screenText().includes("Choose an input."));
  await send(mask ? "\x1b[B\r" : "\r");
  await waitFor("text prompt", () => screenText().includes(mask ? "Focus masked prompt" : "Focus text prompt"));
  assert.equal(cursorVisible || caretInverse(), false, "opening a prompt while unfocused keeps carets hidden");
  await send("\x1b[I");
  await waitFor("focused prompt", () => cursorVisible && caretInverse());
}

async function resize(cols: number, rows: number): Promise<void> {
  const start = output.length;
  screen.resize(cols, rows);
  terminal.resize(cols, rows);
  // Signal the child explicitly and wait for the new geometry before sending input.
  child.kill("SIGWINCH");
  await waitFor("render at resized geometry", () => output.slice(start).includes(`\x1b[${rows};1H`));
}

function inverseCount(): number {
  const buffer = screen.buffer.active;
  let count = 0;
  for (let row = 0; row < screen.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    for (let col = 0; col < screen.cols; col += 1) {
      if (line?.getCell(col)?.isInverse()) count += 1;
    }
  }
  return count;
}

async function switchMode(next: "regular" | "fullscreen"): Promise<void> {
  await send("/settings\r");
  await waitFor("settings", () => screenText().includes("ZCode settings"));
  await send("\x1b[B\x1b[B\x1b[B\r");
  await waitFor("display picker", () => screenText().includes("Switch between regular and fullscreen"));
  // Apply the switch while unfocused to exercise focus restoration on a new TUI.
  await send(`\x1b[O${next === "fullscreen" ? "\x1b[B" : "\x1b[A"}\r`);
  await waitFor(`display ${next}`, () => screenText().includes(`Display mode: ${next}`));
  for (let i = 0; i < 2 && screenText().includes("ZCode settings"); i += 1) await send("\x1b");
  assert.equal(cursorVisible, false, "mode switch preserves unfocused hardware cursor");
  assert.equal(caretInverse(), false, "mode switch preserves unfocused drawn caret");
  await send("\x1b[I");
  await waitFor("mode switch restores editor caret", () => cursorVisible && caretInverse());
  await focusCycle(`editor after switch to ${next}`);
  if (next === "fullscreen") {
    await send("\x1b[102;6u");
    await waitFor("search after mode switch", () => screenText().includes("Find in transcript"));
    await focusCycle("search after mode switch");
    await send("\x1b");
  }
}

try {
  await waitFor("interactive editor", () => screenText().includes("alpha/model") && cursorVisible && caretInverse(), 20_000);
  // No focus report has arrived: terminals without mode 1004 retain both carets.
  assert.ok(output.includes("\x1b[?1004h"), "focus reporting is enabled regardless of notification settings");
  await focusCycle("empty editor");
  await send("中文👩‍💻é");
  await send("\x1b[D");
  await focusCycle("editor caret inside Unicode input");
  await send("\x03");

  // One read can contain several reports; reports can also be split over reads.
  await send("\x1b[O\x1b[I\x1b[O");
  assert.equal(cursorVisible || caretInverse(), false, "batched reports use the last state");
  terminal.write("\x1b[");
  await Bun.sleep(5); // Stay within the terminal parser's incomplete-CSI timeout.
  await send("I");
  await waitFor("split focus-in", () => cursorVisible && caretInverse());
  await send("\x1b[I\x1b[I");
  assert.equal(cursorVisible && caretInverse(), true, "duplicate focus-in preserves the caret");

  await send("Focus transcript fixture\r");
  await waitFor("transcript search fixture", () => screenText().includes("Focus fixture response."));
  await send("/search Focus\r");
  await waitFor("slash-command search", () => /Search 1\/\d+: Focus/.test(screenText()));
  await focusCycle("slash-command search with matching text");
  await send("\x1b[O");
  assert.ok(inverseCount() > 0, "slash-command search highlighting survives focus loss");
  await send("\x1b[I");
  await waitFor("editor after slash-command search", () => cursorVisible && caretInverse());
  await send("/search clear\r");
  await waitFor("slash-command search cleared", () => !/Search \d+\/\d+: Focus/.test(screenText()));

  if (mode === "fullscreen") {
    await send("\x1b[102;6u"); // Ctrl+Shift+F, CSI-u encoding.
    await waitFor("search overlay", () => screenText().includes("Find in transcript"));
    await focusCycle("empty search with styled placeholder");
    for (const query of ["missing-query", "中文👩‍💻é", "long-query-".repeat(12)]) {
      await send(`\x15${query}`);
      await focusCycle(`search ${query.slice(0, 20)}`);
    }
    await send("\x15Focus");
    await waitFor("search result", () => /1\/\d/.test(screenText()));
    await focusCycle("search with matching text");
    await send("\x1b[O");
    assert.ok(inverseCount() > 0, "search result highlighting survives focus loss");
    const matchHighlights = inverseCount();
    await send("\x1b[I\x1b[<0;10;30M\x1b[<0;10;30m");
    await editorReady();
    await send("\x1b[O");
    assert.equal(inverseCount(), matchHighlights, "an open search loses its caret even after clicking the editor");
    await send("\x1b[I\x1b[102;6u");
    await send("\x1b[102;6uFocus\x1b[O");
    await resize(48, 18);
    assert.equal(cursorVisible || caretInverse(), false, "resizing preserves unfocused carets");
    await send("\x1b[I");
    await waitFor("search restored after resize", () => cursorVisible && caretInverse());
    await focusCycle("narrow search");
    await resize(100, 32);
    await send("\x1b");
    await editorReady();
  }

  for (const mask of [false, true]) {
    await openPrompt(mask);
    await focusCycle(mask ? "empty masked prompt" : "empty text prompt");
    const value = mask ? "focus-fixture-secret" : "中文👩‍💻 instructions ".repeat(8);
    await send(value);
    await focusCycle(mask ? "filled masked prompt" : "wrapped text prompt");
    if (mask) assert.equal(output.includes(value), false, "masked input never appears in output");
    await send("\x1b[O\x1b");
    await waitFor("returned to prompt picker", () => screenText().includes("Choose an input."));
    await send("\x1b");
    assert.equal(cursorVisible || caretInverse(), false, "closing a prompt while unfocused keeps carets hidden");
    await send("\x1b[I");
    await waitFor("editor after prompt", () => cursorVisible && caretInverse());
  }

  await send("/focus-stream\r\x1b[O");
  await waitFor("background redraw", () => screenText().includes("Stream focus still running finished."));
  assert.equal(cursorVisible || caretInverse(), false, "stream redraw stays unfocused");
  await send("\x1b[I");
  await waitFor("editor after stream", () => cursorVisible && caretInverse());
  // Establish the last known state before the login command disables reports.
  await send("\x1b[O");
  await send("/login\r");
  await waitFor("suspended login resumed", () => output.includes("Focus fixture login finished.") && screenText().includes("Login command finished,"));
  assert.equal(cursorVisible || caretInverse(), false, "login resume preserves last known focus");
  await send("\x1b[I");
  await waitFor("editor after login", () => cursorVisible && caretInverse());
  await focusCycle("editor after suspended login");

  await switchMode(mode === "fullscreen" ? "regular" : "fullscreen");
  await switchMode(mode);
  await send("\x1b[O");
  child.kill("SIGTERM");
  assert.equal(await child.exited, 143, "SIGTERM exits after cleanup");
  await Bun.sleep(50);
  await pending;
  assert.equal(cursorVisible, true, "exit restores the shell cursor even when unfocused");
  assert.equal(screen.buffer.active.type, "normal", "exit leaves the alternate screen");
  assert.ok(output.includes("\x1b[?1004l"), "exit disables focus reports");
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await child.exited;
  await Bun.sleep(30);
  await pending;
  clearTimeout(timeout);
  if (!terminal.closed) terminal.close();
  screen.dispose();
  await rm(testHome, { recursive: true, force: true });
}
console.log(`Terminal focus smoke test passed (${mode}, ${notificationMethod}/${notificationCondition}, ${entry}).`);
