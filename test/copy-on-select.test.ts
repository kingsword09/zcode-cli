import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readCopyOnSelect,
  writeCopyOnSelect
} from "../packages/zcode-tui/src/copy-on-select.ts";

describe("fullscreen copy on select", () => {
  test("defaults to enabled and ignores unsupported values", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-copy-on-select-default-"));
    const env = { HOME: home, USERPROFILE: home };
    try {
      expect(await readCopyOnSelect(env)).toBe(true);
      await Bun.write(
        join(home, ".zcode", "cli", "config.json"),
        JSON.stringify({ ui: { copyOnSelect: "disabled" } })
      );
      expect(await readCopyOnSelect(env)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reads and writes the setting without replacing other config", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-copy-on-select-test-"));
    const configDirectory = join(home, ".zcode", "cli");
    const configPath = join(configDirectory, "config.json");
    const env = { HOME: home, USERPROFILE: home };
    try {
      await mkdir(configDirectory, { recursive: true });
      await Bun.write(configPath, JSON.stringify({
        model: { main: "zai/glm-5.2" },
        ui: { tuiMode: "fullscreen", copyOnSelect: false }
      }));

      expect(await readCopyOnSelect(env)).toBe(false);
      await writeCopyOnSelect(true, env);
      expect(await Bun.file(configPath).json()).toEqual({
        model: { main: "zai/glm-5.2" },
        ui: { tuiMode: "fullscreen", copyOnSelect: true }
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
