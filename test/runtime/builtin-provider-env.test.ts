import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasRuntimeBuiltinProviderEnvRecovery, patchRuntimeBuiltinProviderEnvRecovery } from "../../scripts/runtime-provider-env-patches.ts";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const node = Bun.which("node");
const endpoint = "http://127.0.0.1:9";
let directory = "", packageRoot = "", builtinContent = "";
let baselineUnpatched = false;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcode-builtin-env-"));
  packageRoot = join(directory, "package");
  const vendor = join(packageRoot, "vendor");
  await mkdir(join(vendor, "provider"), { recursive: true });
  for (const entry of await readdir(join(root, "vendor"))) {
    if (entry !== "zcode.cjs" && entry !== "provider") {
      await symlink(join(root, "vendor", entry), join(vendor, entry));
    }
  }
  const original = await readFile(join(root, "vendor/zcode.cjs"), "utf8");
  baselineUnpatched = !hasRuntimeBuiltinProviderEnvRecovery(original);
  builtinContent = await readFile(join(root, "vendor/provider/zcode-builtin.json"), "utf8");
  await writeFile(join(vendor, "zcode.cjs"), patchRuntimeBuiltinProviderEnvRecovery(original));
  await writeFile(join(vendor, "unpatched.cjs"), original);
  await writeFile(join(vendor, "provider/zcode-builtin.json"), builtinContent);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ type: "module", version: "0.0.0-test" }));
  const build = await Bun.build({ entrypoints: [join(root, "bin/zcode.ts")], outdir: join(packageRoot, "bin"), target: "node", format: "esm" });
  if (!build.success) throw new Error(`Fixture launcher build failed: ${build.logs.join("\n")}`);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function homeEnv(personal = true) {
  const home = await mkdtemp(join(directory, "home-"));
  const env: NodeJS.ProcessEnv = { ...runtimeTestEnv(home, packageRoot), ZCODE_BASE_URL: endpoint };
  delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  delete env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE;
  if (!personal) delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  return { home, env };
}

async function run(home: string, env: NodeJS.ProcessEnv, args = [join(packageRoot, "vendor/zcode.cjs"), "app-server"], rpc = true) {
  if (!node) throw new Error("Node.js is required for built-in provider runtime tests.");
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(node, args, { cwd: home, env, stdio: "pipe", timeout: 8000, killSignal: "SIGKILL" });
    let stdout = "", stderr = "";
    child.once("error", reject);
    child.stdin.on("error", () => {});
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (rpc && !child.stdin.writableEnded && stdout.split("\n").some(line => {
        try { return JSON.parse(line).id === 1; } catch { return false; }
      })) child.stdin.end();
    });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("close", code => resolve({ code, stdout, stderr }));
    if (rpc) child.stdin.write(`${JSON.stringify({ id: 1, method: "session/list", params: {} })}\n`);
    else child.stdin.end();
  });
}

async function snapshots(home: string) {
  const providerRoot = join(home, ".zcode/v2/runtime/provider");
  const entries = await readdir(providerRoot, { recursive: true }).catch(() => []);
  return entries.filter(entry => entry.endsWith("zcode-builtin.json")).map(entry => join(providerRoot, entry));
}

test.each([false, true])("recovers invalid builtin overrides with personal override=%j", async personal => {
  for (const scenario of ["missing", "invalid-json", "invalid-schema"]) {
    const { home, env } = await homeEnv(personal);
    const override = join(home, "invalid.json");
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = override;
    if (scenario !== "missing") {
      await writeFile(override, scenario === "invalid-json" ? "{invalid-json" : "{}");
    }
    const result = await run(home, env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"id":1');
    expect(result.stderr).toContain(`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ${JSON.stringify(override)}`);
    expect(result.stderr).toContain("using bundled catalog");
    expect(result.stderr).not.toContain("均不可用");
    const active = await snapshots(home);
    expect(active).toHaveLength(1);
    expect(JSON.parse(await readFile(active[0]!, "utf8")).revision).toBe(JSON.parse(builtinContent).revision);
    if (scenario !== "missing") expect(await readFile(override, "utf8")).toBe(scenario === "invalid-json" ? "{invalid-json" : "{}");
  }
}, 30000);

test.each([undefined, "", " \t "])("uses discovery for unset or blank overrides without losing active initialization (%j)", async value => {
  const { home, env } = await homeEnv();
  if (value !== undefined) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = value;
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = " \t ";
  const result = await run(home, env);
  expect(result.code).toBe(0);
  expect(result.stderr).not.toContain("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE");
  expect(await snapshots(home)).toHaveLength(1);
}, 10000);

test("preserves valid custom releases without overwriting their files", async () => {
  const { home, env } = await homeEnv();
  const custom = { ...JSON.parse(builtinContent), revision: JSON.parse(builtinContent).revision + 10 };
  const content = JSON.stringify(custom);
  const customPath = join(home, "custom.json");
  await writeFile(customPath, content);
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = customPath;
  const result = await run(home, env);
  expect(result.code).toBe(0);
  expect(result.stderr).not.toContain("using bundled catalog");
  expect(await readFile(customPath, "utf8")).toBe(content);
  expect(await snapshots(home)).toEqual([]);
}, 10000);

test("retains newer active releases when recovering a stale override", async () => {
  const { home, env } = await homeEnv();
  const platform = `${process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}`;
  const endpointKey = `endpoint-${createHash("sha256").update(endpoint).digest("hex").slice(0, 32)}`;
  const activeRoot = join(home, ".zcode/v2/runtime/provider", platform, "0.0.0-dev", endpointKey);
  await mkdir(activeRoot, { recursive: true });
  const activePath = join(activeRoot, "zcode-builtin.json");
  const newer = { ...JSON.parse(builtinContent), revision: JSON.parse(builtinContent).revision + 1 };
  await writeFile(activePath, JSON.stringify(newer));
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = join(home, "stale.json");
  const result = await run(home, env);
  expect(result.code).toBe(0);
  expect(JSON.parse(await readFile(activePath, "utf8")).revision).toBe(newer.revision);
}, 10000);

test("fails with a diagnostic when neither override nor bundled fallback is usable", async () => {
  const { home, env } = await homeEnv();
  const isolated = join(home, "runtime");
  await mkdir(isolated);
  await writeFile(join(isolated, "zcode.cjs"), await readFile(join(packageRoot, "vendor/zcode.cjs")));
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = join(home, "stale.json");
  const result = await run(home, env, [join(isolated, "zcode.cjs"), "app-server"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("no valid bundled fallback");
}, 10000);

test("recovers the real launcher plugin-validation path, reproducing failure when an unpatched runtime is available", async () => {
  const { home, env } = await homeEnv(false);
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = join(home, "stale.json");
  if (baselineUnpatched) {
    const control = await run(home, env, [join(packageRoot, "vendor/unpatched.cjs"), "app-server"]);
    expect(control.code).toBe(1);
    expect(control.stderr).toContain("均不可用");
  }
  const marketplace = join(home, "marketplace.json");
  await writeFile(marketplace, JSON.stringify({ name: "builtin-env-fixture", plugins: [] }));
  const fixed = await run(home, env, [join(packageRoot, "bin/zcode.js"), "plugins", "validate", "--source", marketplace], false);
  expect(fixed.code).toBe(0);
  expect(fixed.stdout).toContain("Plugin validation completed.");
  expect(fixed.stderr).toContain("using bundled catalog");
}, 15000);
