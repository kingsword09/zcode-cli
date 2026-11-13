import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readTuiShowReasoning } from "../../src/runtime-config-bridge.ts";

test("Desktop reasoning visibility supplies the CLI default and explicit CLI preference wins", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-reasoning-setting-"));
  const env = { ...process.env, HOME: home };
  const desktopFile = join(home, ".zcode", "v2", "setting.json");
  const cliFile = join(home, ".zcode", "cli", "setting.json");
  const put = async (file: string, value: unknown) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  };

  try {
    await put(desktopFile, { messageStreamShowReasoning: false });
    expect(readTuiShowReasoning(env)).toBe(false);

    await put(cliFile, { ui: { showReasoning: true } });
    expect(readTuiShowReasoning(env)).toBe(true);

    await put(desktopFile, { messageStreamShowReasoning: true });
    await put(cliFile, { ui: { showReasoning: false } });
    expect(readTuiShowReasoning(env)).toBe(false);

    await put(cliFile, {});
    expect(readTuiShowReasoning({ ...env, ZCODE_CLI_SETTINGS_FILE: join(home, "isolated.json") })).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("missing Desktop visibility preference keeps the existing show-reasoning default", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-reasoning-default-"));
  try {
    expect(readTuiShowReasoning({ ...process.env, HOME: home })).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
