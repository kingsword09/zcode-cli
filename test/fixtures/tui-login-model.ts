#!/usr/bin/env bun

import { runTui } from "../../packages/zcode-tui/src/index.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Like the runtime, the login writes the default model and credentials to disk,
// but the provider registry only knows the new model after it is reloaded.
const model = "account:bigmodel-individual-coding-plan/GLM-5.3";
let loggedIn = false;
let reloaded = false;
let sessionModel: string | undefined;

delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
delete process.env.ZCODE_CLI_CREDENTIALS_FILE;
delete process.env.ZCODE_DATA_BASE_DIR;

async function writeLogin(): Promise<void> {
  const directory = join(process.env.HOME!, ".zcode", "v2");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "provider_config.json"), JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3" }
    }
  }), "utf8");
  await writeFile(join(directory, "credentials.json"), JSON.stringify({
    "account-provider:account:bigmodel-individual-coding-plan:identity": "identity",
    "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:identity:api-key": "api-key"
  }), "utf8");
}

await runTui({
  loginRequired: true,
  modelOptions: [],
  reloadModelOptions: async () => {
    reloaded = loggedIn;
    return reloaded ? [{ id: model, name: "GLM-5.3" }] : [];
  },
  setTransientModel: async (modelId: string) => {
    if (!reloaded) throw new Error(`Unknown model: ${modelId}`);
    sessionModel = modelId;
    return { model: modelId };
  },
  submitPrompt: async (input: unknown) => {
    if (input === "/login bigmodel-coding-plan") {
      await writeLogin();
      loggedIn = true;
      return { loginRequired: false, response: `Configured BigModel Coding Plan.\nModel: ${model}` };
    }
    return { response: sessionModel ? `Echo from ${sessionModel}: ${String(input)}` : "Select a model before continuing" };
  },
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin
} as Parameters<typeof runTui>[0]);
