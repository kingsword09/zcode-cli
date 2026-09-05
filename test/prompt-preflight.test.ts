import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { missingCodingPlanKey } from "../src/prompt-preflight.ts";
import { promptPreflight } from "../src/launcher.ts";
import { userConfigPath } from "../src/model-access.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "zcode-preflight-"));
  directories.push(home);
  const env = { HOME: home, USERPROFILE: home };
  const file = userConfigPath(env);
  const config = {
    provider: {
      zai: {
        kind: "anthropic", models: { "glm-5.3-flash": {} },
        options: { apiKeyRequired: true, baseURL: "https://api.z.ai/api/anthropic", apiKey: "" },
        headers: {} as Record<string, string>
      }
    },
    model: { main: "zai/glm-5.3-flash" }
  };
  await mkdir(dirname(file), { recursive: true });
  const save = () => writeFile(file, JSON.stringify(config));
  await save();
  return { home, env, file, config, save, options: { env, workingDirectory: home } };
}

describe("prompt credential preflight (offline)", () => {
  test("rejects a keyless Coding Plan without altering configuration", async () => {
    const f = await fixture();
    const before = await readFile(f.file, "utf8");
    expect(await missingCodingPlanKey(f.options)).toContain("No model request was sent");
    expect(await readFile(f.file, "utf8")).toBe(before);
  });

  test("permits configured keys and auth headers without revealing them", async () => {
    const f = await fixture();
    f.config.provider.zai.options.apiKey = "private-fixture-key";
    await f.save();
    expect(await missingCodingPlanKey(f.options)).toBeUndefined();
    f.config.provider.zai.options.apiKey = "";
    f.config.provider.zai.headers.Authorization = "Bearer private-fixture-token";
    await f.save();
    expect(await missingCodingPlanKey(f.options)).toBeUndefined();
  });

  test("defers environment credentials and model overrides to the runtime", async () => {
    const f = await fixture();
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ZCODE_API_KEY", "ZCODE_MODEL_MAIN"]) {
      expect(await missingCodingPlanKey({ ...f.options, env: { ...f.env, [key]: "fixture" } })).toBeUndefined();
    }
    expect(await missingCodingPlanKey({ ...f.options, env: { ...f.env, ANTHROPIC_API_KEY: "  " } })).toBeDefined();
    expect(await missingCodingPlanKey({ ...f.options, env: {
      ...f.env, ZCODE_BASE_URL: "https://zcode.z.ai", ZCODE_MODEL_RETRY_MAX_RETRIES: "5",
      ZCODE_MODEL_TELEMETRY_ENABLED: "0"
    } })).toBeDefined();
  });

  test("does not block a session's different model, OAuth provider, or custom endpoint", async () => {
    const f = await fixture();
    for (const model of ["bigmodel/glm-5.3-flash", "builtin:bigmodel-start-plan/GLM-5.3-Flash", "default"]) {
      expect(await missingCodingPlanKey({ ...f.options, model })).toBeUndefined();
    }
    f.config.provider.zai.options.baseURL = "http://localhost:8000";
    await f.save();
    expect(await missingCodingPlanKey(f.options)).toBeUndefined();
  });

  test("defers project and dotenv overrides in parent directories", async () => {
    const f = await fixture();
    const child = join(f.home, "child");
    await mkdir(child);
    for (const relative of ["zcode.json", ".zcode/config.json", ".env"]) {
      const override = join(f.home, relative);
      await writeFile(override, "{}");
      expect(await missingCodingPlanKey({ ...f.options, workingDirectory: child })).toBeUndefined();
      await rm(override);
    }
  });

  test("leaves malformed configuration to the runtime's own diagnostics", async () => {
    const f = await fixture();
    for (const json of ["null", "[]", "invalid", '{"provider":null}']) {
      await writeFile(f.file, json);
      expect(await missingCodingPlanKey(f.options)).toBeUndefined();
    }
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
