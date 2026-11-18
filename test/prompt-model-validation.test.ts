import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidConfiguredPromptModel } from "../src/prompt-model-validation.ts";

const catalog = (providerId: string, modelId: string, modelIdsKey = "personalModelIds") => ({
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [{ providerId, config: { [modelIdsKey]: [modelId] } }]
    },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }
  }
});

describe("explicit startup model validation", () => {
  test("rejects a model absent from a known provider before runtime launch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-model-validation-"));
    const personalPath = join(directory, "personal.json");
    const builtinPath = join(directory, "builtin.json");
    await writeFile(personalPath, JSON.stringify(catalog("custom", "known-model")));
    await writeFile(builtinPath, JSON.stringify(catalog("builtin", "builtin-model")));
    try {
      expect(await invalidConfiguredPromptModel("custom/missing-model", {
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath
      })).toContain("Unknown model: custom/missing-model");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an unknown provider when both registries are available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-model-validation-"));
    const personalPath = join(directory, "personal.json");
    const builtinPath = join(directory, "builtin.json");
    await writeFile(personalPath, JSON.stringify(catalog("custom", "known-model")));
    await writeFile(builtinPath, JSON.stringify(catalog("builtin", "builtin-model")));
    try {
      expect(await invalidConfiguredPromptModel("missing/model", {
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath
      })).toContain("Unknown model provider: missing");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("accepts builtin model IDs from the builtin registry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-model-validation-"));
    const personalPath = join(directory, "personal.json");
    const builtinPath = join(directory, "builtin.json");
    await writeFile(personalPath, JSON.stringify(catalog("custom", "known-model")));
    await writeFile(builtinPath, JSON.stringify(catalog("account:zai-plan", "GLM-5.3", "builtinModelIds")));
    try {
      expect(await invalidConfiguredPromptModel("account:zai-plan/GLM-5.3", {
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath
      })).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("defers validation if either local registry is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-model-validation-"));
    const personalPath = join(directory, "personal.json");
    await writeFile(personalPath, JSON.stringify(catalog("custom", "known-model")));
    try {
      expect(await invalidConfiguredPromptModel("custom/missing-model", {
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(directory, "not-created.json")
      })).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses the packaged builtin catalog when the runtime has not materialized one yet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-model-validation-"));
    try {
      expect(await invalidConfiguredPromptModel("not-a-real-provider/model", {
        HOME: directory,
        USERPROFILE: directory,
        ZCODE_DATA_BASE_DIR: directory,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(directory, "not-created-personal.json")
      })).toContain("Unknown model provider: not-a-real-provider");
      expect(await invalidConfiguredPromptModel("account:zai-individual-coding-plan/GLM-5.3", {
        HOME: directory,
        USERPROFILE: directory,
        ZCODE_DATA_BASE_DIR: directory,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(directory, "not-created-personal.json")
      })).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
