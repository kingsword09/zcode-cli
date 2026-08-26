import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { readRuntimeCliOptionTypes } from "../src/launcher.ts";
import {
  capabilitiesFromExtractionMetadata,
  parseRuntimeCapabilities
} from "../src/runtime-capabilities.ts";

describe("runtime capabilities", () => {
  test("validates extraction metadata without trusting malformed option entries", () => {
    const capabilities = parseRuntimeCapabilities({
      schemaVersion: 1,
      cli: {
        globalOptions: {
          json: { type: "boolean" },
          "output-format": { type: "string" },
          attach: { type: "string", multiple: true }
        }
      }
    });
    expect(capabilities?.cli.globalOptions["output-format"]).toEqual({ type: "string" });
    expect(capabilities?.cli.globalOptions.attach).toEqual({ type: "string", multiple: true });
    expect(parseRuntimeCapabilities({
      schemaVersion: 1,
      cli: { globalOptions: { json: { type: "number" } } }
    })).toBeUndefined();
    expect(capabilitiesFromExtractionMetadata({ runtimeCapabilities: capabilities })).toEqual(capabilities);
  });

  test("loads option types from extraction metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-capabilities-"));
    const metadata = join(directory, "extraction.json");
    try {
      await writeFile(metadata, JSON.stringify({
        runtimeCapabilities: {
          schemaVersion: 1,
          cli: {
            globalOptions: {
              json: { type: "boolean" },
              "output-format": { type: "string" }
            }
          }
        }
      }));
      expect(readRuntimeCliOptionTypes(metadata)).toEqual({
        json: "boolean",
        "output-format": "string"
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
