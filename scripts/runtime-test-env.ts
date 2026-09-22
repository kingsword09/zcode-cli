import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Runtime tools inherit absolute ZCODE paths; changing HOME alone cannot isolate a check. */
export function runtimeTestEnv(
  testHome: string,
  packageRoot = root,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith("ZCODE_"))),
    HOME: testHome,
    USERPROFILE: testHome,
    ZCODE_DATA_BASE_DIR: testHome,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(testHome, ".zcode", "v2", "provider_config.json"),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(packageRoot, "vendor", "provider", "zcode-builtin.json"),
    ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "",
    ZCODE_DISABLE_MODEL_CATALOG_REFRESH: "1",
    ZCODE_DISABLE_UPDATE_CHECK: "1"
  };
}
