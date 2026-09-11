import { describe, expect, test } from "bun:test";

import {
  autoPermissionResponse,
  builtinAutoPermissionConfig,
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

describe("built-in credential deny: token boundaries (regression: `cat .env` bypass)", () => {
  const config = builtinAutoPermissionConfig();
  const bashBehavior = (command: string) =>
    classifyPermissionRequest({ toolName: "Bash", input: { command }, riskLevel: "medium" }, config)?.behavior;
  const pathBehavior = (toolName: string, file_path: string) =>
    classifyPermissionRequest({ toolName, input: { file_path }, riskLevel: "medium" }, config)?.behavior;

  test("relative credential paths in commands are hard-denied, not auto-allowed", () => {
    for (const command of [
      "cat .env",
      "git diff -- .env",
      "head -50 .npmrc",
      "git show HEAD:.env",
      "cat ~/.ssh/config",
      // Quoted paths still land on the token boundary.
      'cat ".env"'
    ]) {
      expect(bashBehavior(command)).toBe("deny");
    }
  });

  test("credential path followed by a shell separator is hard-denied", () => {
    expect(bashBehavior(".env;cat /etc/passwd")).toBe("deny");
    expect(bashBehavior("cat key.pem && echo done")).toBe("deny");
  });

  test("dotted credential variants are denied for direct file tools", () => {
    expect(pathBehavior("Read", ".env.local")).toBe("deny");
    expect(pathBehavior("Read", "/repo/.env.production")).toBe("deny");
    expect(pathBehavior("Edit", "keys/server.pem.bak")).toBe("deny");
    expect(pathBehavior("Read", "certs/server.pem")).toBe("deny");
  });

  test("similarly named non-credential files are not denied (no false-positive widening)", () => {
    expect(bashBehavior("cat environment")).toBe("allow");
    expect(bashBehavior("cat .environment")).toBe("allow");
    expect(bashBehavior("cat notes/.envsample")).toBe("allow");
    expect(pathBehavior("Read", "src/my.env")).toBe("allow");
  });
});

describe("built-in find allowlist: execution actions (regression: `find . -exec sh` auto-allow)", () => {
  const config = builtinAutoPermissionConfig();
  const verdictFor = (command: string) =>
    classifyPermissionRequest({ toolName: "Bash", input: { command }, riskLevel: "high" }, config);

  test("plain find stays auto-allowed", () => {
    expect(verdictFor("find . -name '*.test.ts'")?.behavior).toBe("allow");
    expect(verdictFor("find src -type f -newer README.md")?.behavior).toBe("allow");
    // Only the trailing word boundary keeps -executable distinct from -exec.
    expect(verdictFor("find . -type f -executable")?.behavior).toBe("allow");
  });

  test("find with -exec/-execdir/-ok/-okdir falls through to the dialog", () => {
    expect(verdictFor("find . -exec sh -c 'touch /tmp/pwned' \\;")).toBeNull();
    expect(verdictFor("find . -type f -execdir chmod 777 {} +")).toBeNull();
    expect(verdictFor("find . -ok rm {} \\;")).toBeNull();
    expect(verdictFor("find . -okdir rm {} \\;")).toBeNull();
    // A quoted flag still reaches find's parser, so the guard must too.
    expect(verdictFor("find . '-exec' sh -c 'x' \\;")).toBeNull();
    // Separators must not rescind the guard: the classifier sees one
    // command string, whether the separator is quoted or compound.
    expect(verdictFor("find . -name 'a|b' -exec sh -c 'x' \\;")).toBeNull();
    expect(verdictFor("find . ; find . -exec sh -c 'x' \\;")).toBeNull();
  });

  test("find's file-mutating actions fall through to the dialog", () => {
    expect(verdictFor("find . -name '*.log' -delete")).toBeNull();
    expect(verdictFor("find . -fprintf /tmp/pwned '%p\\n'")).toBeNull();
    expect(verdictFor("find . -fls /tmp/pwned")).toBeNull();
  });

  test("file names that merely contain a flag substring fail safe to the dialog", () => {
    expect(verdictFor("find . -name 'foo-exec'")).toBeNull();
  });
});
