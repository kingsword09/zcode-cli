#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { nextBuildVersion } from "./release-version.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
const currentVersion = String(packageJson.version ?? "");
const nextVersion = nextBuildVersion(currentVersion);

packageJson.version = nextVersion;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`${currentVersion} -> ${nextVersion}`);
