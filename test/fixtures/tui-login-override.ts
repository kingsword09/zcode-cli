#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required for the login override fixture.");
const directory = join(home, ".zcode", "cli");
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "config.json"), `${JSON.stringify({
  provider: {
    zai: {
      kind: "anthropic",
      options: { apiKey: "override-fixture-key", baseURL: "https://example.test/api/anthropic" },
      models: { "override-model": { name: "Override model" } }
    }
  },
  model: { main: "zai/override-model", lite: "zai/override-model" }
}, null, 2)}\n`);
console.log("External login command completed.");
