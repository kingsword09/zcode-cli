import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { runtimeTestEnv } from "../scripts/runtime-test-env.ts";

test("isolates runtime configuration while selecting the package under test", () => {
  const testHome = resolve("fixture-home"), installedPackage = resolve("installed-package");
  const inherited = {
    HOME: "/parent", USERPROFILE: "/parent", PATH: "fixture-path", TERM: "xterm",
    ZCODE_NODE: "/parent/node", ZCODE_DATA_BASE_DIR: "/parent/data",
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/parent/providers.json",
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/parent/builtin.json",
    ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "/parent/bundled.json",
    ZCODE_CLI_MIGRATE_CONFIG: "1", ZCODE_TUI_MODE: "fullscreen"
  };
  const env = runtimeTestEnv(testHome, installedPackage, inherited);
  expect(env).toMatchObject({
    HOME: testHome, USERPROFILE: testHome, ZCODE_DATA_BASE_DIR: testHome,
    PATH: inherited.PATH, TERM: inherited.TERM,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(testHome, ".zcode/v2/provider_config.json"),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(installedPackage, "vendor/provider/zcode-builtin.json"),
    ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: ""
  });
  expect(env.ZCODE_NODE).toBeUndefined();
  expect(env.ZCODE_CLI_MIGRATE_CONFIG).toBeUndefined();
  expect(env.ZCODE_TUI_MODE).toBeUndefined();
  expect(inherited.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBe("/parent/providers.json");
});
