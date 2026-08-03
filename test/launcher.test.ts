import { describe, expect, test } from "bun:test";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatVersionOutput,
  isVersionInvocation,
  normalizeLoginArgs,
  prepareModelOverride,
  readDistributionVersion,
  readRuntimeVersion,
  resolveModelRetryMaxRetries
} from "../src/launcher.ts";
import { classifyZaiOAuthInvocation } from "../src/zai-oauth.ts";

describe("launcher routing", () => {
  test("uses five runtime retries by default and preserves an explicit override", () => {
    expect(resolveModelRetryMaxRetries({})).toBe("5");
    expect(resolveModelRetryMaxRetries({ ZCODE_MODEL_RETRY_MAX_RETRIES: " 2 " })).toBe("2");
    expect(resolveModelRetryMaxRetries({ ZCODE_MODEL_RETRY_MAX_RETRIES: " " })).toBe("5");
  });

  test("translates --model into an isolated settings override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-model-"));
    const configPath = join(directory, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({ provider: { zai: { options: { apiKey: "secret" } } }, model: { main: "zai/old", lite: "zai/lite" } }));
      const prepared = await prepareModelOverride(
        ["--prompt", "OK", "--model", "zai/glm-5.2", "--settings", configPath],
        { HOME: directory },
      );
      expect(prepared.args).not.toContain("--settings");
      expect(prepared.args).not.toContain("--model");
      const settingsPath = join(prepared.env.HOME!, ".zcode", "cli", "config.json");
      const settings = JSON.parse(await Bun.file(settingsPath).text());
      expect(settings.model).toEqual({ main: "zai/glm-5.2", lite: "zai/lite" });
      expect(settings.provider.zai.options.apiKey).toBe("secret");
      await prepared.cleanup();
      expect(await Bun.file(settingsPath).exists()).toBe(false);
      expect(prepared.env.USERPROFILE).toBe(prepared.env.HOME);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("supports equals syntax and preserves unrelated runtime arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-model-equals-"));
    const configPath = join(directory, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({ model: { lite: "zai/lite" }, provider: {} }));
      const prepared = await prepareModelOverride(
        ["--prompt", "OK", "--settings=" + configPath, "--model=zai/glm-5.2", "--mode", "edit"],
        { HOME: directory },
      );
      expect(prepared.args).toEqual(["--prompt", "OK", "--mode", "edit"]);
      const settingsPath = join(prepared.env.HOME!, ".zcode", "cli", "config.json");
      const settings = JSON.parse(await Bun.file(settingsPath).text());
      expect(settings.model).toEqual({ main: "zai/glm-5.2", lite: "zai/lite" });
      await prepared.cleanup();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects duplicate and missing model options", async () => {
    await expect(prepareModelOverride(["--model", "a", "--model=b"], {})).rejects.toThrow(
      "--model may be specified only once",
    );
    await expect(prepareModelOverride(["--model", "--mode", "edit"], {})).rejects.toThrow(
      "--model requires a non-empty value",
    );
  });

  test("reads a safe npm distribution version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-version-"));
    const manifest = join(directory, "package.json");
    try {
      await writeFile(manifest, JSON.stringify({ version: "3.3.5-1" }));
      expect(readDistributionVersion(manifest)).toBe("3.3.5-1");
      await writeFile(manifest, JSON.stringify({ version: "bad\u001b[2J" }));
      expect(readDistributionVersion(manifest)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reads and labels both npm package and bundled runtime versions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-version-"));
    const metadata = join(directory, "extraction.json");
    try {
      await writeFile(metadata, JSON.stringify({ cliVersion: "0.15.2" }));
      expect(readRuntimeVersion(metadata)).toBe("0.15.2");
      await writeFile(metadata, JSON.stringify({ cliVersion: "bad\u001b[2J" }));
      expect(readRuntimeVersion(metadata)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(formatVersionOutput("3.3.6-3", "0.15.2")).toBe(
      "zcode-app-cli 3.3.6-3\nzcode-runtime 0.15.2"
    );
    expect(isVersionInvocation(["version"])).toBe(true);
    expect(isVersionInvocation(["--version"])).toBe(true);
    expect(isVersionInvocation(["-v"])).toBe(true);
    expect(isVersionInvocation(["--json", "version"])).toBe(false);
  });

  test("checks configured access by default and keeps an explicit OAuth escape hatch", () => {
    expect(normalizeLoginArgs(["login"])).toEqual({
      args: ["login"],
      checkConfiguredAccess: true
    });
    expect(normalizeLoginArgs(["login", "--oauth"])).toEqual({
      args: ["login"],
      checkConfiguredAccess: false
    });
    expect(normalizeLoginArgs(["login", "--no-browser"])).toEqual({
      args: ["login", "--no-browser"],
      checkConfiguredAccess: false
    });
  });

  test("routes only the plain Z.AI login command through the Desktop OAuth bridge", () => {
    expect(classifyZaiOAuthInvocation(["login"])).toEqual({
      json: false,
      noBrowser: false,
      runtimeArgs: ["login"]
    });
    expect(classifyZaiOAuthInvocation(["login", "--oauth", "--no-browser"])).toEqual({
      json: false,
      noBrowser: true,
      runtimeArgs: ["login", "--no-browser"]
    });
    expect(classifyZaiOAuthInvocation(["--json", "login", "--oauth"])).toEqual({
      json: true,
      noBrowser: false,
      runtimeArgs: ["--json", "login"]
    });
    expect(classifyZaiOAuthInvocation(["login", "zai-coding-plan-api-key", "secret"])).toBeNull();
    expect(classifyZaiOAuthInvocation(["login", "--unknown"])).toBeNull();
  });
});
