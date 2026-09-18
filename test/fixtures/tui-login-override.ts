#!/usr/bin/env bun
import { writeProviderFixture } from "./provider-config.ts";
await writeProviderFixture(process.env, { providerId: "zai", modelId: "override-model", apiKey: "override-fixture-key" });
console.log("External login command completed.");
