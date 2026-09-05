import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { userConfigPath } from "./model-access.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    // An unreadable override is also a reason to defer to the runtime.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Diagnose only unambiguous keyless Coding Plan configs, not general model access. */
export async function missingCodingPlanKey(options: {
  env?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  model?: string;
} = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (Object.entries(env).some(([key, value]) => value?.trim()
    && key !== "ZCODE_BASE_URL" && !key.startsWith("ZCODE_MODEL_RETRY_")
    && key !== "ZCODE_MODEL_TELEMETRY_ENABLED"
    && /^(?:ZCODE|ZAI|BIGMODEL|ZHIPU|ANTHROPIC)_.*(?:KEY|TOKEN|MODEL|CONFIG|PROVIDER|BASE_URL)/u.test(key))) {
    return undefined;
  }
  let directory = resolve(options.workingDirectory ?? process.cwd());
  while (true) {
    if ((await Promise.all([
      join(directory, "zcode.json"),
      join(directory, ".zcode", "config.json"),
      join(directory, ".env")
    ].map(exists))).some(Boolean)) return undefined;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  let config: Record<string, unknown> | undefined;
  try {
    config = record(JSON.parse(await readFile(userConfigPath(env), "utf8")));
  } catch {
    return undefined;
  }
  const model = options.model ?? record(config?.model)?.main;
  if (typeof model !== "string") return undefined;
  const providerId = model.split("/", 1)[0];
  if (providerId !== "zai" && providerId !== "bigmodel") return undefined;
  const provider = record(record(config?.provider)?.[providerId]);
  const settings = record(provider?.options);
  const expectedUrl = providerId === "zai"
    ? "https://api.z.ai/api/anthropic"
    : "https://open.bigmodel.cn/api/anthropic";
  if (provider?.kind !== "anthropic" || settings?.baseURL !== expectedUrl
    || settings?.apiKeyRequired !== true
    || (typeof settings.apiKey === "string" && settings.apiKey.trim())
    || (settings.apiKey !== undefined && typeof settings.apiKey !== "string")
    || Object.keys(record(provider.headers) ?? {}).length > 0) return undefined;
  return `Model access is not configured for ${providerId}. Run /login or /setup in zcode, `
    + "or configure its API key before sending a prompt. No model request was sent.";
}
