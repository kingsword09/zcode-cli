import { expect, test } from "bun:test";
import { parseRuntimeLock, selectRuntimeLock } from "../scripts/sync-runtime.ts";
import { parseReleaseVersion, syncedReleaseVersion } from "../scripts/release-version.ts";
import { validatePackResult, type PackResult } from "../scripts/pack-release.ts";
import { pluginLicenseFiles, publishedFiles } from "../scripts/package-contents.ts";

const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
const lock = parseRuntimeLock(await Bun.file(new URL("../zcode-runtime.lock.json", import.meta.url)).json());

test("the package version and verified remote runtime lock identify the same release", () => {
  expect(parseReleaseVersion(manifest.version)?.appVersion).toBe(lock.appVersion);
  expect(lock.platform).toBe("linux");
  expect(lock.arch).toBe("x64");
  expect(new URL(lock.url).protocol).toBe("https:");
  expect(manifest.files).toContain("zcode-runtime.lock.json");
  expect(() => parseRuntimeLock({ ...lock, sha512: "not-a-checksum" })).toThrow();
  expect(() => parseRuntimeLock({ ...lock, url: "http://example.test/runtime.deb" })).toThrow();
});

test("a lagging update manifest cannot downgrade the pinned runtime", () => {
  expect(selectRuntimeLock({ ...lock, appVersion: "0.0.0" }, lock)).toBe(lock);
});

test("a runtime upgrade preserves the CLI build number", () => {
  expect(syncedReleaseVersion("9.0.0", "8.0.0-41")).toBe("9.0.0-41");
});

test("the tarball contract accepts published documentation and rejects missing or unreviewed files", () => {
  const paths = [
    ...publishedFiles.filter((path) => path !== "vendor"),
    ...pluginLicenseFiles,
    "package.json",
    "vendor/extraction.json",
    "vendor/node_modules/@zcode/tui/dist/index.js",
    "vendor/node_modules/@zcode/tui/package.json",
    "vendor/zcode.cjs",
    "vendor/cli-config.cjs",
    "vendor/provider/zcode-builtin.json"
  ];
  const result: PackResult = {
    name: manifest.name, version: manifest.version, filename: "fixture.tgz",
    size: 0, unpackedSize: 0, integrity: "fixture", shasum: "fixture",
    files: paths.map((path) => ({ path, mode: path === "bin/zcode.js" ? 0o755 : 0o644, size: 0 }))
  };

  expect(() => validatePackResult(result, manifest)).not.toThrow();
  expect(() => validatePackResult({
    ...result, files: result.files.filter((file) => file.path !== "docs/HEADLESS.md")
  }, manifest)).toThrow("npm tarball is missing: docs/HEADLESS.md");
  expect(() => validatePackResult({
    ...result, files: [...result.files, { path: "docs/unreviewed.md", mode: 0o644, size: 0 }]
  }, manifest)).toThrow("npm tarball contains an unreviewed path: docs/unreviewed.md");
});
