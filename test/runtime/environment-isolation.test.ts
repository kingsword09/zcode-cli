import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerFixture } from "../fixtures/provider-config.ts";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

const root = join(import.meta.dir, "../..");

async function assertParentConfigPreserved(args: string[], timeoutMs: number): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-test-parent-"));
  const personal = join(home, "provider_config.json"), builtin = join(home, "builtin.json");
  const contents = JSON.stringify(providerFixture({ providerId: "parent-provider", apiKey: "parent-fixture-key" }));
  try {
    await writeFile(personal, contents);
    await copyFile(join(import.meta.dir, "../../vendor/provider/zcode-builtin.json"), builtin);
    const builtinBefore = await readFile(builtin, "utf8");
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: home,
      // Reproduce the absolute paths exported by the CLI into its Bash tools.
      env: { ...runtimeTestEnv(home), ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: builtin },
      stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ]);
      expect(code, stderr || stdout).toBe(0);
      expect(await readFile(personal, "utf8")).toBe(contents);
      expect(await readFile(builtin, "utf8")).toBe(builtinBefore);
      expect(await readdir(home)).not.toContain(".zcode");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("migration tests preserve the provider files inherited from a running ZCode session", async () => {
  await assertParentConfigPreserved(["test", join(import.meta.dir, "config-migration.test.ts")], 20_000);
}, 25_000);

test("runtime checks preserve inherited provider files and storage", async () => {
  await assertParentConfigPreserved([join(root, "scripts/check-runtime.ts")], 20_000);
}, 25_000);

test.skipIf(process.platform === "win32")("TUI smoke checks keep login changes inside their temporary home", async () => {
  await assertParentConfigPreserved([join(root, "scripts/smoke-tui.ts")], 40_000);
}, 45_000);
