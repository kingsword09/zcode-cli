import { expect, test } from "bun:test";
import { join } from "node:path";

interface TemplateProvider {
  kind: string;
  options: {
    apiKey: string;
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
}

test("custom-provider config template is internally consistent", async () => {
  const file = Bun.file(join(import.meta.dir, "..", "config.example.json"));
  const config = (await file.json()) as ConfigTemplate;
  const [providerId, modelId] = config.model.main.split("/", 2);

  expect(config.model.lite).toBe(config.model.main);
  expect(providerId).toBe("zai");
  expect(config.provider[providerId]?.kind).toBe("anthropic");
  expect(config.provider[providerId]?.models[modelId]).toBeDefined();
  expect(config.provider[providerId]?.options.apiKey).toBe("REPLACE_WITH_YOUR_API_KEY");
  expect(config.provider[providerId]?.options.baseURL).toBe("https://example.com/api/anthropic");
});
