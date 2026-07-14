import { describe, expect, test } from "bun:test";

import { isTuiInvocation, normalizeLoginArgs } from "../src/launcher.ts";
import { classifyZaiOAuthInvocation } from "../src/zai-oauth.ts";

describe("launcher routing", () => {
  test("routes full-screen invocations through Bun.Terminal", () => {
    expect(isTuiInvocation([])).toBe(true);
    expect(isTuiInvocation(["tui"])).toBe(true);
    expect(isTuiInvocation(["--cwd", "/tmp", "--mode", "plan"])).toBe(true);
    expect(isTuiInvocation(["--resume", "sess_123"])).toBe(true);
    expect(isTuiInvocation(["--cwd", "doctor"])).toBe(true);
  });

  test("keeps protocol and headless commands on inherited stdio", () => {
    expect(isTuiInvocation(["app-server"])).toBe(false);
    expect(isTuiInvocation(["doctor", "--json"])).toBe(false);
    expect(isTuiInvocation(["--cwd", "/tmp", "doctor"])).toBe(false);
    expect(isTuiInvocation(["--prompt", "hello"])).toBe(false);
    expect(isTuiInvocation(["tui", "--help"])).toBe(false);
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
