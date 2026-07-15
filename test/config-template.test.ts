import { expect, test } from "bun:test";
import { join } from "node:path";

interface TemplateProvider {
  kind: string;
  options: {
    apiKey?: string;
    baseURL: string;
  };
  models: Record<string, unknown>;
}

interface ConfigTemplate {
  provider: Record<string, TemplateProvider>;
  model: {
    main: string;
    lite: string;
  };
  ui: {
    theme: string;
    notifications: {
      method: string;
      condition: string;
    };
  };
}

test("custom-provider config template is internally consistent", async () => {
  const file = Bun.file(join(import.meta.dir, "..", "config.example.json"));
  const config = (await file.json()) as ConfigTemplate;
  const [providerId, modelId] = config.model.main.split("/", 2);

  const [liteProviderId, liteModelId] = config.model.lite.split("/", 2);
  expect(providerId).toBe("zai");
  expect(liteProviderId).toBe(providerId);
  expect(config.provider[providerId]?.kind).toBe("anthropic");
  expect(config.provider[providerId]?.models[modelId]).toBeDefined();
  expect(config.provider[providerId]?.models[liteModelId]).toBeDefined();
  expect(config.provider[providerId]?.options.apiKey).toBeUndefined();
  expect(config.provider[providerId]?.options.baseURL).toBe("https://api.z.ai/api/anthropic");
  expect(config.ui.theme).toBe("auto");
  expect(config.ui.notifications).toEqual({ method: "auto", condition: "unfocused" });
});
