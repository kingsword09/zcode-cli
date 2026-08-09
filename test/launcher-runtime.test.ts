import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readRuntimeVersion } from "../src/launcher.ts";

let home = "";
const node = Bun.which("node");
const root = fileURLToPath(new URL("..", import.meta.url));

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "zcode-launcher-runtime-"));
});

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

async function run(args: string[], input = "") {
  if (!node) throw new Error("Node.js is required for launcher/runtime integration tests.");
  const child = Bun.spawn([process.execPath, "bin/zcode.ts", ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ZCODE_NODE: node
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  child.stdin.write(input);
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { code, stdout, stderr };
}

describe("launcher/runtime integration", () => {
  test("keeps non-agent runtime subcommands usable", async () => {
    const doctor = await run(["doctor", "--json"]);
    expect(doctor.code).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ cli: { version: readRuntimeVersion() } });

    const plugins = await run(["plugins", "list", "--json"]);
    expect(plugins.code).toBe(0);
    expect(JSON.parse(plugins.stdout).plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "browser-use", enabled: true })
    ]));

    const skills = await run(["skills", "list", "--json"]);
    expect(skills.code).toBe(0);
    expect(JSON.parse(skills.stdout).skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedName: "browser-use:control-browser" })
    ]));
  }, 30_000);

  test("passes app-server through unchanged and exposes Plugin references", async () => {
    const workspacePath = root.replace(/\/$/u, "");
    const request = {
      id: 1,
      method: "plugins/referenceCatalog",
      params: {
        workspace: { workspacePath, workspaceKey: workspacePath }
      }
    };
    const result = await run(["app-server"], `${JSON.stringify(request)}\n`);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 1,
      result: {
        plugins: expect.arrayContaining([
          expect.objectContaining({
            pluginId: "browser-use@zcode-plugins-official",
            skillQualifiedNames: expect.arrayContaining(["browser-use:control-browser"])
          })
        ])
      }
    });
  }, 30_000);

  test("resolves a real Plugin install dry-run without changing storage", async () => {
    const result = await run([
      "plugins",
      "install",
      "browser-use@zcode-plugins-official",
      "--dry-run",
      "--json"
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      description: {
        components: expect.arrayContaining([
          expect.objectContaining({
            kind: "skill",
            items: expect.arrayContaining([
              expect.objectContaining({ name: "control-browser" })
            ])
          })
        ])
      },
      plan: {
        dependencyClosure: [],
        diagnostics: []
      }
    });
  }, 30_000);

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
    expect(JSON.parse(plugins.stdout).plugins).toEqual(expect.arrayContaining([
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
