import { describe, expect, test } from "bun:test";

import { isTuiInvocation } from "../src/launcher.ts";

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
});
