import { describe, expect, test } from "bun:test";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeLoginArgs, readDistributionVersion } from "../src/launcher.ts";
import { classifyZaiOAuthInvocation } from "../src/zai-oauth.ts";

describe("launcher routing", () => {
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
