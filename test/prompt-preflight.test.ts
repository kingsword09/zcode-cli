import { writeProviderFixture } from "./fixtures/provider-config.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { missingCodingPlanKey } from "../src/prompt-preflight.ts";
import { promptPreflight } from "../src/launcher.ts";
import { providerConfigPath } from "../src/model-access.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "zcode-preflight-"));
  directories.push(home);
  const env = { HOME: home, USERPROFILE: home };
  const { config, path: file } = await writeProviderFixture(env, { providerId: "zai", modelId: "GLM-5.3", apiType: "anthropic-messages" });
  const settings = config.config.providerConfigRules.providerRules[0]!.config;
  const save = () => writeFile(file, JSON.stringify(config));
  return { home, env, file, config, settings, save, options: { env, workingDirectory: home } };
}

describe("prompt credential preflight (offline)", () => {
  test("rejects a keyless Coding Plan without altering configuration", async () => {
    const f = await fixture();
    const before = await readFile(f.file, "utf8");
    expect(await missingCodingPlanKey(f.options)).toContain("No model request was sent");
    expect(await readFile(f.file, "utf8")).toBe(before);
  });

  test("leaves malformed configuration to the runtime's own diagnostics", async () => {
    const f = await fixture();
    for (const json of ["null", "[]", "invalid", '{"provider":null}']) {
      await writeFile(f.file, json);
      expect(await missingCodingPlanKey(f.options)).toBeUndefined();
    }
  });

  test("checks an explicit prompt model instead of the saved default", async () => {
    const f = await fixture();
    expect(await promptPreflight(["--cwd", f.home, "-p", "hello"], f.env,
      "account:zai-individual-coding-plan/GLM-5.3-Flash")).toBeUndefined();
  });

  test("covers headless prompt forms while preserving help, login and resume", async () => {
    const f = await fixture();
    for (const args of [["--prompt", "hello"], ["--prompt=hello"], ["--print", "hello"], ["-p", "hello"], ["--target", "hello"]]) {
      expect(await promptPreflight(["--cwd", f.home, ...args], f.env)).toBeDefined();
    }
    for (const args of [["--help"], ["login"], ["tui"], ["doctor"], ["--prompt", "hello", "--help"],
      ["--prompt", "hello", "--resume", "session"], ["-c", "--prompt", "hello"], ["--prompt", "hello", "--continue"]]) {
      expect(await promptPreflight([`--cwd=${f.home}`, ...args], f.env)).toBeUndefined();
    }
  });
});
