import { describe, expect, test } from "bun:test";

import {
  loginFailureDiagnostic,
  shouldSuspendForLoginCommand,
  shouldUseNoBrowserForLogin,
  suspendedZaiLoginCommand
} from "../packages/zcode-tui/src/index.ts";

describe("TUI external login routing", () => {
  test("suspends for the Z.AI browser OAuth selection only", () => {
    expect(shouldSuspendForLoginCommand("/login zai-coding-plan")).toBe(true);
    expect(shouldSuspendForLoginCommand("/login bigmodel-coding-plan")).toBe(false);
    expect(shouldSuspendForLoginCommand("/login zai-coding-plan-api-key")).toBe(false);
  });

  test("uses browserless login for SSH and displayless Linux sessions", () => {
    expect(shouldUseNoBrowserForLogin({ SSH_CONNECTION: "host 1" }, "darwin")).toBe(true);
    expect(shouldUseNoBrowserForLogin({}, "linux")).toBe(true);
    expect(shouldUseNoBrowserForLogin({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(shouldUseNoBrowserForLogin({}, "darwin")).toBe(false);
  });

  test("re-enters the Bun launcher instead of passing --oauth to the official runtime", () => {
    expect(suspendedZaiLoginCommand({
      ZCODE_APP_CLI_BUN: "/opt/bun",
      ZCODE_APP_CLI_ENTRY: "/package/bin/zcode.ts"
    }, "/opt/node", "/package/vendor/zcode.cjs")).toEqual({
      args: ["/package/bin/zcode.ts", "login", "--oauth"],
      program: "/opt/bun"
    });
    expect(suspendedZaiLoginCommand({}, "/opt/node", "/package/vendor/zcode.cjs")).toEqual({
      args: ["/package/vendor/zcode.cjs", "login"],
      program: "/opt/node"
    });
  });

  test("prefers the actual error over the final help line", () => {
    expect(loginFailureDiagnostic("", [
      "Unknown option '--oauth'",
      "Usage: zcode [command]",
      "/goal [action] Show or set the current session goal"
    ].join("\n"))).toBe("Unknown option '--oauth'");
  });
});
