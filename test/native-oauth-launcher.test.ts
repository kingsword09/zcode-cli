import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test.skipIf(process.platform === "darwin")("native OAuth preserves flags, isolated credentials and login outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-native-login-"));
  try {
    const entry = join(root, "package", "bin", "zcode.js");
    const build = await Bun.build({ entrypoints: [resolve("bin/zcode.ts")], target: "node" });
    expect(build.success).toBe(true);
    await mkdir(join(root, "package", "bin"), { recursive: true });
    await mkdir(join(root, "package", "vendor"), { recursive: true });
    await writeFile(join(root, "package", "package.json"), '{"type":"module"}');
    await writeFile(entry, await build.outputs[0]!.text());
    await writeFile(join(root, "package", "vendor", "extraction.json"), JSON.stringify({
      appVersion: "3.14.4",
      runtimeCapabilities: { schemaVersion: 1, cli: { globalOptions: { "no-browser": { type: "boolean" } } } }
    }));
    await writeFile(join(root, "package", "vendor", "zcode.cjs"), `
      const fs = require("node:fs");
      const env = process.env;
      fs.writeFileSync(env.ZCODE_TEST_CAPTURE, JSON.stringify({
        args: process.argv.slice(2), credentials: env.ZCODE_CLI_CREDENTIALS_FILE,
        desktopBridge: env.ZCODE_CLI_OAUTH_CALLBACK_STDIN, appVersion: env.ZCODE_APP_VERSION
      }));
      if (env.ZCODE_TEST_WRITE_CREDENTIALS === "1") {
        const providerId = "account:zai-individual-coding-plan";
        fs.writeFileSync(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, JSON.stringify({
          schemaVersion: 1, config: { defaultModelSelection: { providerId, modelId: "GLM-5.3" } }
        }));
        fs.writeFileSync(env.ZCODE_CLI_CREDENTIALS_FILE, JSON.stringify({
          ["account-provider:" + providerId + ":identity"]: "fixture-identity",
          ["account-provider:coding-plan:" + providerId + ":account:fixture:api-key"]: "fixture-key"
        }));
      }
      process.exit(Number(env.ZCODE_TEST_EXIT));
    `);
    for (const [status, writeCredentials, pending] of [[0, true, false], [7, false, true], [0, false, true]] as const) {
      const home = join(root, `home-${status}-${writeCredentials}`);
      const cli = join(home, ".zcode", "cli");
      await mkdir(cli, { recursive: true });
      const credentials = join(cli, "credentials.json");
      const capture = join(home, "capture.json");
      const appVersion = status === 7 ? "9.9.9" : "3.14.4";
      const child = spawnSync(Bun.which("node")!, [entry, "login", "--oauth", "--no-browser"], {
        cwd: home,
        env: { ...process.env, HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: home,
          ZCODE_NODE: Bun.which("node")!, ZCODE_CLI_CREDENTIALS_FILE: credentials,
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(cli, "provider_config.json"),
          ZCODE_TEST_CAPTURE: capture, ZCODE_TEST_EXIT: String(status),
          ZCODE_APP_VERSION: status === 7 ? appVersion : "",
          ZCODE_TEST_WRITE_CREDENTIALS: writeCredentials ? "1" : "0" },
        encoding: "utf8", timeout: 10_000
      });
      expect({ status: child.status, stderr: child.stderr }).toEqual({ status, stderr: "" });
      expect(JSON.parse(await readFile(capture, "utf8"))).toEqual({
        args: ["login", "--no-browser"], credentials, appVersion
      });
      expect(await Bun.file(join(cli, "setup-pending")).exists()).toBe(pending);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
