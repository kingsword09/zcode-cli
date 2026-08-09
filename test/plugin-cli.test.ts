import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { runPluginCommand, type PluginRequestInput } from "../src/plugin-cli.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

function output(): { stream: Writable & { isTTY?: boolean }; text: () => string } {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += String(chunk);
      callback();
    }
  }) as Writable & { isTTY?: boolean };
  return { stream, text: () => value };
}

function harness(responses: Record<string, unknown> = {}) {
  const stdout = output();
  const stderr = output();
  const calls: PluginRequestInput[] = [];
  return {
    calls,
    options: {
      confirm: async () => true,
      cwd: "/workspace",
      request: async (request: PluginRequestInput) => {
        calls.push(request);
        return responses[request.method] ?? {};
      },
      stderr: stderr.stream,
      stdout: stdout.stream
    },
    stderr,
    stdout
  };
}

describe("plugin CLI routing", () => {
  test("delegates runtime-owned commands and prompt text", async () => {
    const testHarness = harness();
    expect(await runPluginCommand(["plugins", "list", "--json"], testHarness.options)).toBeUndefined();
    expect(await runPluginCommand(["--prompt", "plugins", "install"], testHarness.options)).toBeUndefined();
    expect(testHarness.calls).toHaveLength(0);
  });

  test("shows extended plugin help and rejects unknown options locally", async () => {
    const helpHarness = harness();
    expect(await runPluginCommand(["plugins", "--help"], helpHarness.options)).toBe(0);
    expect(helpHarness.stdout.text()).toContain("zcode plugins marketplace add");

    const invalidHarness = harness();
    expect(await runPluginCommand(
      ["plugins", "install", "audit@example", "--unknown"],
      invalidHarness.options
    )).toBe(1);
    expect(invalidHarness.stderr.text()).toContain("Unknown option");
    expect(invalidHarness.calls).toHaveLength(0);
  });

  test("lists marketplace discovery through the public protocol", async () => {
    const overview = {
      marketplaces: [{ id: "official", pluginCount: 2, isOfficial: true }],
      availablePlugins: [],
      installedPlugins: [],
      restorableBuiltins: []
    };
    const testHarness = harness({ "plugins/overview": overview });

    expect(await runPluginCommand(["--json", "plugins", "discover"], testHarness.options)).toBe(0);
    expect(testHarness.calls).toHaveLength(1);
    expect(testHarness.calls[0]).toMatchObject({
      method: "plugins/overview",
      params: {
        workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" }
      },
      workingDirectory: "/workspace"
    });
    expect(JSON.parse(testHarness.stdout.text())).toEqual(overview);
  });

  test("previews plugin components and dependencies before installing", async () => {
    const testHarness = harness({
      "plugins/describe": {
        components: [{ kind: "skill", items: [{ name: "audit" }] }],
        metadata: { author: "Example", version: "1.0.0" }
      },
      "plugins/install": {
        dependencyClosure: ["base@example"],
        installedPlugins: [{ id: "audit@example" }]
      }
    });

    expect(await runPluginCommand(
      ["plugins", "install", "audit@example", "--scope", "workspace", "--yes"],
      testHarness.options
    )).toBe(0);
    expect(testHarness.calls.map((call) => call.method)).toEqual([
      "plugins/overview",
      "plugins/describe",
      "plugins/install",
      "plugins/install"
    ]);
    expect(testHarness.calls[2]?.params).toMatchObject({
      dryRun: true,
      marketplace: "example",
      pluginName: "audit",
      scope: "workspace"
    });
    expect(testHarness.calls[3]?.params).not.toHaveProperty("dryRun");
    expect(testHarness.stdout.text()).toContain("Components: skill: audit");
    expect(testHarness.stdout.text()).toContain("Dependencies: base@example");
  });

  test("does not invent dependency information for describe", async () => {
    const testHarness = harness({
      "plugins/describe": {
        components: [{ kind: "skill", items: [{ name: "audit" }] }]
      }
    });

    expect(await runPluginCommand(
      ["plugins", "describe", "audit@example"],
      testHarness.options
    )).toBe(0);
    expect(testHarness.stdout.text()).toContain("Components: skill: audit");
    expect(testHarness.stdout.text()).not.toContain("Dependencies:");
  });

  test("does not mutate when installation confirmation is declined", async () => {
    const testHarness = harness({
      "plugins/describe": { components: [] },
      "plugins/install": { dependencyClosure: [], installedPlugins: [] }
    });
    testHarness.options.confirm = async () => false;

    expect(await runPluginCommand(["plugins", "install", "audit@example"], testHarness.options)).toBe(1);
    expect(testHarness.calls.map((call) => call.method)).toEqual([
      "plugins/overview",
      "plugins/describe",
      "plugins/install"
    ]);
    expect(testHarness.stderr.text()).toContain("installation cancelled");
  });

  test("validates a marketplace before adding it", async () => {
    const testHarness = harness({
      "plugins/marketplace/add": { marketplace: { id: "example" }, diagnostics: [] }
    });

    expect(await runPluginCommand(
      ["plugins", "marketplace", "add", "owner/repository", "--yes"],
      testHarness.options
    )).toBe(0);
    expect(testHarness.calls.map((call) => call.params.dryRun)).toEqual([true, undefined]);
    expect(testHarness.stdout.text()).not.toContain("capability changes apply");
  });

  test("rejects ignored dry-run flags before destructive operations", async () => {
    const testHarness = harness();

    expect(await runPluginCommand([
      "plugins",
      "marketplace",
      "remove",
      "example",
      "--dry-run",
      "--yes"
    ], testHarness.options)).toBe(1);
    expect(testHarness.stderr.text()).toContain("--dry-run is not supported");
    expect(testHarness.calls).toHaveLength(0);
  });

  test("keeps JSON stdout parseable while prompting on stderr", async () => {
    const testHarness = harness({
      "plugins/marketplace/add": { marketplace: { id: "example" }, diagnostics: [] }
    });
    const stdin = Readable.from(["yes\n"]) as Readable & { isTTY?: boolean };
    stdin.isTTY = true;
    testHarness.stdout.stream.isTTY = true;
    testHarness.stderr.stream.isTTY = true;

    expect(await runPluginCommand(
      ["plugins", "marketplace", "add", "owner/repository", "--json"],
      {
        ...testHarness.options,
        confirm: undefined,
        stdin
      }
    )).toBe(0);
    expect(JSON.parse(testHarness.stdout.text())).toMatchObject({ marketplace: { id: "example" } });
    expect(testHarness.stderr.text()).toContain("Add marketplace from owner/repository?");
  });

  test("loads plugin configuration from a JSON file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-options-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "options.json"), JSON.stringify({ endpoint: "https://example.com" }));
    const testHarness = harness({ "plugins/configure": { pluginId: "audit@example", diagnostics: [] } });
    testHarness.options.cwd = directory;

    expect(await runPluginCommand([
      "plugins",
      "configure",
      "audit@example",
      "--options-file",
      "options.json",
      "--dry-run"
    ], testHarness.options)).toBe(0);
    expect(testHarness.calls[0]?.params).toMatchObject({
      dryRun: true,
      options: { endpoint: "https://example.com" },
      pluginId: "audit@example"
    });
  });

  test("rejects malformed coordinates before calling the runtime", async () => {
    const testHarness = harness();
    expect(await runPluginCommand(
      ["plugins", "describe", "missing-marketplace"],
      testHarness.options
    )).toBe(1);
    expect(testHarness.calls).toHaveLength(0);
    expect(testHarness.stderr.text()).toContain("Expected <name>@<marketplace>");
  });

  test("removes terminal control characters from errors", async () => {
    const testHarness = harness();
    expect(await runPluginCommand(
      ["plugins", "describe", "bad\u001b[31m@example"],
      testHarness.options
    )).toBe(1);
    expect(testHarness.stderr.text()).not.toContain("\u001b");
    expect(testHarness.stderr.text()).toContain("bad?[31m@example");
  });

  test("does not install when dry-run diagnostics contain errors", async () => {
    const testHarness = harness({
      "plugins/describe": {
        components: [],
        diagnostics: [{ code: "plugin_not_found", message: "Missing", severity: "error" }]
      },
      "plugins/install": {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [{ code: "plugin_not_found", message: "Missing", severity: "error" }]
      }
    });

    expect(await runPluginCommand(
      ["plugins", "install", "missing@example", "--yes", "--json"],
      testHarness.options
    )).toBe(1);
    expect(testHarness.calls.map((call) => call.method)).toEqual([
      "plugins/overview",
      "plugins/describe",
      "plugins/install"
    ]);
  });

  test("maps validation error diagnostics to a failed exit status and message", async () => {
    const testHarness = harness({
      "plugins/validate": {
        diagnostics: [{ message: "Invalid manifest", severity: "error" }]
      }
    });

    expect(await runPluginCommand(
      ["plugins", "validate", "--source", "./plugin"],
      testHarness.options
    )).toBe(1);
    expect(testHarness.stdout.text()).toContain("Plugin validation failed.");
    expect(testHarness.stdout.text()).not.toContain("changes apply");
  });
});
