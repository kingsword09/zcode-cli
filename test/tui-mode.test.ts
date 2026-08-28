import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTuiMode, resolveTuiMode, writeTuiMode } from "../packages/zcode-tui/src/tui-mode.ts";

describe("TUI mode resolution", () => {
  test("uses environment overrides before options and config", () => {
    expect(resolveTuiMode({ ZCODE_TUI_MODE: "fullscreen" }, { ui: { tuiMode: "regular" } }))
      .toBe("fullscreen");
    expect(resolveTuiMode({}, { ui: { tuiMode: "fullscreen" } }))
      .toBe("fullscreen");
  });

  test("ignores unsupported overrides before falling back", () => {
    expect(resolveTuiMode({ ZCODE_TUI_MODE: "unsupported" }, { ui: { tuiMode: "fullscreen" } }))
      .toBe("fullscreen");
    expect(resolveTuiMode({}, { ui: { tuiMode: "unsupported" } }))
      .toBe("regular");
  });

  test("reads and writes the persisted mode without replacing other config", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-tui-mode-test-"));
    const configDir = join(home, ".zcode", "cli");
    const env = { HOME: home, USERPROFILE: home };
    try {
      await mkdir(configDir, { recursive: true });
      const configPath = join(configDir, "config.json");
      await Bun.write(configPath, JSON.stringify({ model: { main: "zai/glm-5.2" }, ui: { tuiMode: "fullscreen" } }));
      expect(await readTuiMode(env)).toBe("fullscreen");
      await writeTuiMode("regular", env);
      expect(await Bun.file(configPath).json()).toEqual({
        model: { main: "zai/glm-5.2" },
        ui: { tuiMode: "regular" }
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
