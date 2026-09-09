import { describe, expect, test } from "bun:test";

import {
  autoPermissionResponse,
  classifyPermissionRequest,
  loadAutoPermissionConfig,
  type AutoPermissionConfig
} from "../packages/zcode-tui/src/auto-permissions.ts";

const baseRequest = {
  toolName: "Bash",
  input: { command: "git status" } as unknown,
  riskLevel: "high" as string | undefined
};

function makeConfig(overrides: Partial<AutoPermissionConfig> = {}): AutoPermissionConfig {
  return {
    defaults: { unmatched: "ask" },
    allow: [],
    softDeny: [],
    hardDeny: [],
    ...overrides
  };
}

describe("auto-permissions classification seam", () => {
  test("classifies a read-only bash command as allow", () => {
    const verdict = classifyPermissionRequest(baseRequest, makeConfig({
      allow: [{ tool: "Bash", commandPrefix: "git status" }]
    }));
    expect(verdict).toEqual({
      behavior: "allow",
      reason: expect.stringContaining("git status"),
      matchedRule: expect.anything()
    });
  });

  test("classification result maps to the dialog's response shape", () => {
    const verdict = classifyPermissionRequest(baseRequest, makeConfig({
      allow: [{ tool: "Bash", commandPrefix: "git status" }]
    }));
    // This is the exact contract requestPermission() returns to the runtime.
    expect(verdict).not.toBeNull();
    expect(verdict?.behavior).toBe("allow");
    expect(verdict?.reason).toContain("git status");
  });

  test("hard deny wins over allow on compound commands", () => {
    const verdict = classifyPermissionRequest({
      toolName: "Bash",
      input: { command: "git status && rm -rf /tmp/x" },
      riskLevel: "critical"
    }, makeConfig({
      allow: [{ tool: "Bash", commandPrefix: "git status" }],
      hardDeny: [{ tool: "Bash", commandRegex: String.raw`\brm\s+-[a-zA-Z]*r[a-zA-Z]*f` }]
    }));
    expect(verdict).not.toBeNull();
    expect(verdict?.behavior).toBe("deny");
  });

  test("unmatched tool defers to the dialog when defaults ask", () => {
    const verdict = classifyPermissionRequest({
      toolName: "Write",
      input: { file_path: "/repo/src/app.ts" },
      riskLevel: "medium"
    }, makeConfig());
    expect(verdict).toBeNull();
  });

  test("credential paths are never auto-allowed", () => {
    const verdict = classifyPermissionRequest({
      toolName: "Read",
      input: { file_path: "/repo/.env" },
      riskLevel: "medium"
    }, makeConfig({
      allow: [{ tool: "Read" }],
      hardDeny: [{ tool: ["Read", "Write", "Edit"], pathRegex: String.raw`(^|[/\\])\.env([/\\]|$)` }]
    }));
    expect(verdict).not.toBeNull();
    expect(verdict?.behavior).toBe("deny");
  });

  test("built-in config loads and carries conservative defaults", () => {
    const config = loadAutoPermissionConfig(undefined);
    expect(config.defaults.unmatched).toBe("ask");
    expect(config.allow.length).toBeGreaterThan(0);
    expect(config.hardDeny.length).toBeGreaterThan(0);
  });

  test("autoPermissionResponse returns the dialog's exact response object for allow and deny", () => {
    const config = makeConfig({
      allow: [{ tool: "Bash", commandPrefix: "git status" }],
      hardDeny: [{ tool: "Bash", commandRegex: String.raw`\bsudo\s` }]
    });
    expect(autoPermissionResponse({ toolName: "Bash", input: { command: "git status" } }, config))
      .toEqual({ decision: "allow", reason: expect.stringContaining("auto-permissions") });
    expect(autoPermissionResponse({ toolName: "Bash", input: { command: "sudo ls" } }, config))
      .toEqual({ decision: "deny", reason: expect.stringContaining("pattern match") });
  });

  test("autoPermissionResponse returns null (dialog path) for unmatched requests", () => {
    expect(autoPermissionResponse(
      { toolName: "Write", input: { file_path: "/repo/src/app.ts" } },
      makeConfig()
    )).toBeNull();
  });
});
