import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

const root = join(import.meta.dir, "../..");

async function fixture() {
  const testHome = await mkdtemp(join(tmpdir(), "zcode-config-doctor-"));
  const workspace = join(testHome, "workspace");
  await mkdir(workspace, { recursive: true });
  const settings = join(testHome, ".zcode", "cli", "setting.json");
  const put = async (file: string, value: unknown) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  };
  const run = async (args = ["doctor", "--json"]) => {
    const child = Bun.spawn([Bun.which("node")!, join(root, "bin/zcode.js"), "--cwd", workspace, ...args], {
      cwd: testHome, env: runtimeTestEnv(testHome), stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  return { testHome, workspace, settings, put, run, close: () => rm(testHome, { recursive: true, force: true }) };
}

test("doctor checks a fresh profile without requiring login or creating settings and migration markers", async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.cli.version).toBeString();
    expect(report.configuration.user).toMatchObject({ path: f.settings, status: "missing", mcpServerNames: [] });
    expect(report.configuration.mcp.servers).toEqual([]);
    expect(await Bun.file(f.settings).exists()).toBe(false);
    expect(await Bun.file(join(dirname(f.settings), "migrations", "settings-v1.json")).exists()).toBe(false);
  } finally { await f.close(); }
}, 15000);

test("doctor reads settings after migration, preserves native MCP precedence and never starts a server", async () => {
  const f = await fixture();
  try {
    const marker = join(f.testHome, "server-started");
    const http = { type: "http", url: "http://127.0.0.1:1/mcp?token=SECRET_VALUE", headers: { Authorization: "SECRET_VALUE" } };
    await f.put(f.settings, { mcp: { servers: { shared: http, local: {
      type: "stdio", command: Bun.which("node")!, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], env: { TOKEN: "SECRET_VALUE" }
    }, disabled: { ...http, enabled: false } } } });
    await f.put(join(dirname(f.settings), "migrations", "settings-v1.json"), { schemaVersion: 1 });
    await f.put(join(dirname(f.settings), "config.json"), { mcp: { servers: { legacy: http } } });
    await f.put(join(f.workspace, ".zcode", "config.json"), { mcp: { servers: { shared: { type: "stdio", command: "unused" }, project: http } } });
    await f.put(join(f.testHome, ".agents", "mcp.json"), { mcpServers: { userFallback: http } });
    await f.put(join(f.workspace, ".agents", "mcp.json"), { mcpServers: { projectFallback: http } });
    const before = await readFile(f.settings, "utf8");
    const result = await f.run();
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout).configuration;
    expect(report.user.status).toBe("loaded");
    expect(report.project.status).toBe("loaded");
    expect(report.mcp.servers).toEqual([
      { name: "disabled", type: "http", enabled: false, source: "user" },
      { name: "local", type: "stdio", enabled: true, source: "user" },
      { name: "project", type: "http", enabled: true, source: "project" },
      { name: "shared", type: "http", enabled: true, source: "user" }
    ]);
    expect(report.legacy).toMatchObject({ exists: true, usage: "first-run-migration-only" });
    expect(result.stdout + result.stderr).not.toContain("SECRET_VALUE");
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await readFile(f.settings, "utf8")).toBe(before);
    const text = await f.run(["doctor"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Configuration:");
    expect(text.stdout).toContain('"shared": http, user, enabled');
    expect(text.stdout).toContain("connections were not tested");
  } finally { await f.close(); }
}, 15000);

test("doctor surfaces rejected settings and individual MCP entries without falling back to other files", async () => {
  const f = await fixture();
  try {
    const server = { type: "http", url: "http://127.0.0.1:1/mcp" };
    await f.put(join(f.testHome, ".agents", "mcp.json"), { mcpServers: { fallback: server } });
    await f.put(join(dirname(f.settings), "config.json"), { mcp: { servers: { legacy: server } } });
    await f.put(f.settings, { ui: { theme: "system" }, mcp: { servers: { valid: server } } });
    let result = await f.run();
    expect(result.code).toBe(1);
    let report = JSON.parse(result.stdout).configuration;
    expect(report.user.status).toBe("invalid");
    expect(report.mcp.servers).toEqual([]);
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "config_file_invalid", filePath: f.settings, message: expect.stringContaining("ui.theme")
    })]));
    await f.put(f.settings, { mcp: { servers: { valid: server, bad: { type: "stdio" } } } });
    result = await f.run();
    expect(result.code).toBe(1);
    report = JSON.parse(result.stdout).configuration;
    expect(report.user.status).toBe("loaded");
    expect(report.mcp.servers.map((s: { name: string }) => s.name)).toEqual(["valid"]);
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "config_mcp_server_invalid", path: "mcp.servers.bad", message: expect.stringContaining("command")
    })]));
    await writeFile(f.settings, '{"secret":"SECRET_VALUE", BROKEN');
    result = await f.run();
    expect(result.code).toBe(1);
    report = JSON.parse(result.stdout).configuration;
    expect(report.user.status).toBe("invalid");
    expect(result.stdout + result.stderr).not.toContain("SECRET_VALUE");
    expect(await readFile(f.settings, "utf8")).toContain("SECRET_VALUE");
    expect(await Bun.file(join(dirname(f.settings), "migrations", "settings-v1.json")).exists()).toBe(false);
    await f.put(f.settings, { mcp: { servers: {} } });
    result = await f.run();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).configuration.mcp.servers).toEqual([]);
  } finally { await f.close(); }
}, 15000);
