import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readConfiguredModelAccess, userConfigPath } from "../src/model-access.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-model-access-"));
  temporaryDirectories.push(home);
  return home;
}

describe("configured model access", () => {
  test("detects an internally consistent custom provider", async () => {
    const home = await temporaryHome();
    const path = userConfigPath({ HOME: home });
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(path, JSON.stringify({
      provider: {
        zai: {
          options: { apiKey: "configured-key" },
          models: { "custom/model": { name: "Custom" } }
        }
      },
      model: { main: "zai/custom/model" }
    }));

    expect(await readConfiguredModelAccess({ HOME: home })).toEqual({
      configPath: path,
      model: "zai/custom/model",
      providerId: "zai"
    });
  });

  test("rejects missing keys, missing models, and invalid JSON", async () => {
    const home = await temporaryHome();
    const path = userConfigPath({ HOME: home });
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(path, JSON.stringify({
      provider: { zai: { options: {}, models: { model: {} } } },
      model: { main: "zai/model" }
    }));
    expect(await readConfiguredModelAccess({ HOME: home })).toBeNull();
    await writeFile(path, "not-json");
    expect(await readConfiguredModelAccess({ HOME: home })).toBeNull();
  });
});
