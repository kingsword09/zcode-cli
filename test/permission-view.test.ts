import { describe, expect, test } from "bun:test";

import { PermissionPreview } from "../packages/zcode-tui/src/permission-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

describe("TUI permission preview", () => {
  test("uses readable light-terminal emphasis and strips external SGR", () => {
    const view = new PermissionPreview(
      createTheme(true, "light"),
      "Bash",
      { command: "\x1b[47;8;7mbun test\x1b[0m" },
      "medium"
    );
    const rendered = view.render(72).join("\n");
    expect(rendered).toContain("\x1b[38;5;58;48;5;230m");
    expect(rendered).toContain("bun test");
    expect(rendered).not.toContain("\x1b[47;8;7m");
  });

  test("reserves the error surface for high-risk permission requests", () => {
    const view = new PermissionPreview(
      createTheme(true, "dark"),
      "Bash",
      { command: "rm -rf build" },
      "high"
    );
    expect(view.render(72).join("\n")).toContain("\x1b[38;5;252;48;5;52m");
  });
});
