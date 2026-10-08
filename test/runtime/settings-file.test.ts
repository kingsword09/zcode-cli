import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

const root = join(import.meta.dir, "../..");

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "zcode-settings-override-"));
  const workspace = join(home, "workspace"), hostFile = join(home, "host card", "settings.json");
  const homeFile = join(home, ".zcode", "cli", "setting.json");
  const legacyFile = join(home, ".zcode", "cli", "config.json");
  const desktopFile = join(home, ".zcode", "v2", "setting.json");
  const storage = join(home, "host-storage"), oldStorage = join(home, "home-storage");
  const env = { ...runtimeTestEnv(home), ZCODE_CLI_SETTINGS_FILE: ` ${hostFile} ` };
  const put = async (file: string, value: unknown) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  };
  await mkdir(workspace);
  await put(homeFile, { hooks: { enabled: false }, storage: { dir: oldStorage }, ui: { locale: "en-US" } });
  await put(legacyFile, { hooks: { enabled: false }, storage: { dir: oldStorage } });
  await put(desktopFile, { localePreference: "zh-CN", memoryEnabled: false });
  const originals = await Promise.all([homeFile, legacyFile, desktopFile].map(async file => [file, await readFile(file, "utf8")] as const));
  const run = async (entry: string, args: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const child = Bun.spawn([Bun.which("node")!, join(root, entry), ...args], {
      cwd: workspace, env: { ...env, ...overrides }, stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr || stdout).toBe(0);
    return JSON.parse(stdout);
  };
  return {
    home, workspace, hostFile, storage, oldStorage, put,
    cli: (args: string[], overrides?: NodeJS.ProcessEnv) => run("bin/zcode.js", args, overrides),
    probe: (locale?: string) => run("test/fixtures/settings-file-runtime.cjs", [workspace, ...locale ? [locale] : []]),
    assertOriginals: async () => {
      for (const [file, contents] of originals) expect(await readFile(file, "utf8")).toBe(contents);
    },
    close: () => rm(home, { recursive: true, force: true })
  };
}

test("launcher and native settings writes use the host file while preserving project MCP precedence", async () => {
  const f = await fixture();
  try {
    const http = { type: "http", url: "http://127.0.0.1:1/mcp" };
    await f.put(f.hostFile, {
      storage: { dir: f.storage }, hooks: { enabled: true }, permission: { mode: "edit", allowedTools: ["Read"] },
      mcp: { servers: { shared: { ...http, enabled: false }, host: http } }
    });
    await f.put(join(f.workspace, ".zcode", "config.json"), { mcp: { servers: { shared: http, project: http } } });
    const otherFile = join(f.home, "other card", "settings.json");
    await f.put(otherFile, { mcp: { servers: { other: http } } });
    const [first, other] = await Promise.all([
      f.cli(["doctor", "--json"]),
      f.cli(["doctor", "--json"], { ZCODE_CLI_SETTINGS_FILE: otherFile })
    ]);
    expect(first.configuration.user).toMatchObject({ path: f.hostFile, status: "loaded" });
    expect(first.configuration.user.mcpServerNames.toSorted()).toEqual(["host", "shared"]);
    expect(first.configuration.mcp.servers).toEqual([
      { name: "host", type: "http", enabled: true, source: "user" },
      { name: "project", type: "http", enabled: true, source: "project" },
      { name: "shared", type: "http", enabled: false, source: "user" }
    ]);
    expect(other.configuration.user).toMatchObject({ path: otherFile, mcpServerNames: ["other"] });

    const state = await f.probe("en-US");
    expect(state.settingsPath).toBe(f.hostFile);
    expect(state.loaded).toMatchObject({ loaded: true, path: f.hostFile, config: {
      hooks: { enabled: true }, permission: { mode: "edit", allowedTools: ["Read"] },
      ui: { locale: "zh-CN" }, memory: { use: false }, features: { memory: false }
    } });
    expect(JSON.parse(await readFile(f.hostFile, "utf8")).ui.locale).toBe("en-US");
    await f.assertOriginals();
  } finally { await f.close(); }
}, 15_000);

test("hook trust grant and revoke use the same host-selected store as app bootstrap", async () => {
  const f = await fixture();
  try {
    await f.put(f.hostFile, { storage: { dir: f.storage }, hooks: { enabled: true } });
    await f.put(join(f.workspace, ".zcode", "config.json"), { hooks: { enabled: true, events: {
      PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "echo hook-fixture" }] }]
    } } });
    const args = ["--workspace", f.workspace, "--json"];
    const status = await f.cli(["hooks", "trust", "status", ...args]);
    expect(status.reasonCode).toBe("workspace_hooks_pending_trust");
    const granted = await f.cli(["hooks", "trust", "grant", "--all-current", "--bundle-digest", status.bundleDigest, ...args]);
    expect(granted.reasonCode).toBe("workspace_hooks_trusted_persistent");

    const state = await f.probe();
    const expectedStore = join(f.storage, "security", "workspace-hook-trust-v1.json");
    expect(state.trustPath).toBe(expectedStore);
    expect(state.appTrustPath).toBe(expectedStore);
    expect(state.trust.reasonCode).toBe("workspace_hooks_trusted_persistent");
    expect(state.trust.items[0].trustState).toBe("trusted_persistent");
    expect(await Bun.file(expectedStore).exists()).toBe(true);
    expect(await Bun.file(join(f.oldStorage, "security", "workspace-hook-trust-v1.json")).exists()).toBe(false);

    await f.cli(["hooks", "trust", "revoke", "--all", ...args]);
    expect((await f.probe()).trust.reasonCode).toBe("workspace_hooks_pending_trust");
    await f.assertOriginals();
  } finally { await f.close(); }
}, 15_000);
