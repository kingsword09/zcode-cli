import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  displayWorkspacePath,
  FullscreenHeader,
  SessionWelcome
} from "../packages/zcode-tui/src/fullscreen-header.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

const options = {
  branch: "feat-1",
  distributionVersion: "3.9.2-16",
  runtimeVersion: "0.16.5",
  workspace: "/Users/alice/Documents/code/zcode-cli",
  homeDirectory: "/Users/alice"
};

describe("fullscreen session header", () => {
  test("shortens workspace paths using the home directory", () => {
    expect(displayWorkspacePath(options.workspace, options.homeDirectory))
      .toBe("~/Documents/code/zcode-cli");
    expect(displayWorkspacePath("/tmp/zcode", options.homeDirectory)).toBe("/tmp/zcode");
  });

  test("keeps a one-line rail through narrow widths", () => {
    const header = new FullscreenHeader(createTheme(false), options);
    header.setPhase("rail");
    for (const width of [1, 8, 20, 40, 80, 120]) {
      const lines = header.render(width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0] ?? "")).toBe(width);
    }
    expect(header.render(80)[0]).toStartWith("── ");
    expect(header.render(80)[0]).toContain("◆ ZCODE");
    expect(header.render(80)[0]).toContain("feat-1");
  });

  test("keeps welcome frames within tiny and wide terminal widths", () => {
    const theme = createTheme(false);
    const header = new FullscreenHeader(theme, options);
    const welcome = new SessionWelcome(
      theme,
      (width) => header.location(width),
      (width) => header.identity(width),
      { includeIdentity: true, loginRequired: true }
    );

    for (const width of [1, 2, 5, 8, 20, 40, 76, 100, 160]) {
      const lines = welcome.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(welcome.render(160).every((line) => visibleWidth(line) <= 76)).toBe(true);
  });

  test("uses the versioned identity only for the welcome phase", () => {
    const header = new FullscreenHeader(createTheme(false), options);
    expect(header.render(80)[0]).toContain("v3.9.2-16");
    header.setPhase("transition");
    expect(header.render(80)[0]).toContain("◆ ZCODE");
    expect(header.render(80)[0]).not.toContain("v3.9.2-16");
  });

  test("renders regular and fullscreen welcome surfaces without a wide logo", () => {
    const theme = createTheme(false);
    const header = new FullscreenHeader(theme, options);
    const regular = new SessionWelcome(
      theme,
      (width) => header.location(width),
      (width) => header.identity(width),
      { includeIdentity: true }
    );
    const fullscreen = new SessionWelcome(
      theme,
      (width) => header.location(width),
      (width) => header.identity(width),
      { includeIdentity: false, loginRequired: true }
    );

    const regularLines = regular.render(100);
    const fullscreenLines = fullscreen.render(100);
    expect(regularLines).toHaveLength(4);
    expect(regularLines[0]).toStartWith("╭─ ");
    expect(regularLines[0]).toContain(" ─");
    expect(regularLines.at(-1)).toStartWith("╰─ ");
    expect(regularLines.at(-1)).toContain(" ─");
    expect(regularLines.join("\n")).toContain("ZCODE");
    expect(fullscreenLines).toHaveLength(5);
    expect(fullscreenLines[0]).toStartWith("╭─ ");
    expect(fullscreenLines[0]).toContain(" ─");
    expect(fullscreenLines.at(-1)).toStartWith("╰─ ");
    expect(fullscreenLines.join("\n")).toContain("Run /login");
    expect(fullscreenLines.join("\n")).not.toContain("SYSTEM INITIATED");
  });
});
