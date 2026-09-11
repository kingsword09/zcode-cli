import { expect, test } from "bun:test";

import { TerminalScreen } from "./harness/terminal-screen.ts";

test("headless terminal reports the current screen instead of erased output", async () => {
  using screen = new TerminalScreen(20, 4);
  await screen.write("stale panel");
  expect(screen.screenText()).toContain("stale panel");

  await screen.write("\x1b[2J\x1b[Hcurrent panel");

  expect(screen.screenText()).toBe("current panel");
  expect(screen.bufferText()).not.toContain("stale panel");
});

test("headless terminal follows alternate-screen transitions", async () => {
  using screen = new TerminalScreen(20, 4);
  await screen.write("main screen");
  await screen.write("\x1b[?1049h\x1b[Halternate");

  expect(screen.snapshot()).toMatchObject({
    buffer: "alternate",
    cols: 20,
    rows: 4,
    text: "alternate"
  });

  await screen.write("\x1b[?1049l");

  expect(screen.snapshot()).toMatchObject({
    buffer: "normal",
    text: "main screen"
  });
});

test("headless terminal separates the visible viewport from scrollback", async () => {
  using screen = new TerminalScreen(20, 3);
  await screen.write("one\r\ntwo\r\nthree\r\nfour");

  expect(screen.screenText()).toBe("two\nthree\nfour");
  expect(screen.bufferText()).toBe("one\ntwo\nthree\nfour");
});

test("headless terminal preserves visible Unicode cells and resize state", async () => {
  using screen = new TerminalScreen(12, 3);
  await screen.write("权限 ✓");
  screen.resize(16, 4);

  expect(screen.snapshot()).toEqual({
    buffer: "normal",
    cols: 16,
    cursor: { x: 6, y: 0 },
    rows: 4,
    text: "权限 ✓"
  });
});
