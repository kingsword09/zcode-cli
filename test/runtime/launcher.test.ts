import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readRuntimeVersion } from "../../src/launcher.ts";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

let home = "";
const node = Bun.which("node");
const root = fileURLToPath(new URL("../..", import.meta.url));

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "zcode-launcher-runtime-"));
});

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

async function run(args: string[], input = "", environment: Record<string, string> = {}, responseId?: number) {
  if (!node) throw new Error("Node.js is required for launcher/runtime integration tests.");
  const child = Bun.spawn([process.execPath, "bin/zcode.ts", ...args], {
    cwd: root,
    env: {
      ...runtimeTestEnv(environment.HOME ?? home),
      ZCODE_NODE: node,
      ...environment
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  child.stdin.write(input);
  if (responseId === undefined) child.stdin.end();
  const stdoutPromise = (async () => {
    const decoder = new TextDecoder();
    let output = "", pending = "";
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      output += text;
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (responseId === undefined) continue;
        try {
          if (JSON.parse(line).id === responseId) child.stdin.end();
        } catch { /* Non-protocol output is retained for assertions. */ }
      }
    }
    return output + decoder.decode();
  })();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    stdoutPromise,
    new Response(child.stderr).text()
  ]);
  return { code, stdout, stderr };
}

describe("launcher/runtime integration", () => {
  test("rejects a keyless prompt before starting the runtime or creating a session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-keyless-prompt-"));
    const fakeNode = join(directory, "fake-node");
    await writeFile(fakeNode, "#!/bin/sh\nprintf 'RUNTIME_STARTED'\nexit 99\n");
    await chmod(fakeNode, 0o755);
    try {
      const result = await run(["--cwd", directory, "--prompt", "offline test"], "", {
        HOME: directory, USERPROFILE: directory, ZCODE_NODE: fakeNode, ANTHROPIC_API_KEY: "",
        // Preflight deliberately defers when explicit model/config environment overrides exist.
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "",
        ZCODE_DISABLE_MODEL_CATALOG_REFRESH: ""
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("No model request was sent");
      expect(result.stdout).not.toContain("RUNTIME_STARTED");
      expect(await Bun.file(join(directory, ".zcode", "cli", "db", "db.sqlite")).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("shows a missing resume target without exposing unrelated runtime diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-launcher-missing-session-"));
    const fakeNode = join(directory, "fake-node");
    await writeFile(fakeNode, [
      "#!/bin/sh",
      "printf '%s\\n' 'ProviderBusinessError: internal diagnostics' >&2",
      "printf '%s' 'Error: Session not ' >&2",
      "printf '%s\\n' 'found: sess_missing_target' >&2",
      "exit 1",
      ""
    ].join("\n"));
    await chmod(fakeNode, 0o755);
    try {
      const result = await run(["--cwd", directory, "--resume", "sess_missing_target"], "", {
        ZCODE_NODE: fakeNode, ZCODE_TUI_RUNTIME_LOG: join(directory, "runtime.log")
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Session not found: sess_missing_target");
      expect(result.stderr).not.toContain("ProviderBusinessError");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("adds a local marketplace and installs its Plugin end to end", async () => {
    const marketplace = join(home, "fixture-marketplace");
    const plugin = join(marketplace, "plugin");
    await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
    await mkdir(join(plugin, "skills", "smoke-skill"), { recursive: true });
    await writeFile(join(marketplace, "marketplace.json"), `${JSON.stringify({
      name: "cli-smoke-marketplace",
      pluginRoot: ".",
      plugins: [{
        description: "CLI smoke plugin",
        name: "cli-smoke-plugin",
        source: "./plugin",
        version: "1.0.0"
      }]
    }, null, 2)}\n`);
    await writeFile(join(plugin, ".zcode-plugin", "plugin.json"), `${JSON.stringify({
      description: "CLI smoke plugin",
      name: "cli-smoke-plugin",
      skills: "skills",
      version: "1.0.0"
    }, null, 2)}\n`);
    await writeFile(join(plugin, "skills", "smoke-skill", "SKILL.md"), [
      "---",
      "name: smoke-skill",
      "description: Verify marketplace installation.",
      "---",
      "",
      "Verify installation.",
      ""
    ].join("\n"));

    const added = await run(["plugins", "marketplace", "add", marketplace, "--yes", "--json"]);
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({
      marketplace: { id: "cli-smoke-marketplace", pluginCount: 1 },
      diagnostics: []
    });

    const installed = await run([
      "plugins",
      "install",
      "cli-smoke-plugin@cli-smoke-marketplace",
      "--yes",
      "--json"
    ]);
    expect(installed.code).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({
      installedPlugins: expect.arrayContaining([
        expect.objectContaining({
          enabled: true,
          id: "cli-smoke-plugin@cli-smoke-marketplace"
        })
      ]),
      diagnostics: []
    });

    const plugins = await run(["plugins", "list", "--json"]);
    expect(JSON.parse(plugins.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        enabled: true,
        id: "cli-smoke-plugin@cli-smoke-marketplace",
        skillCount: 1
      })
    ]));

    const skills = await run(["skills", "list", "--json"]);
    expect(JSON.parse(skills.stdout).skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedName: "cli-smoke-plugin:smoke-skill" })
    ]));
  }, 30_000);
});
