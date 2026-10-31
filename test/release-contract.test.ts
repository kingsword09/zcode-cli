import { expect, test } from "bun:test";
import { parseRuntimeLock, selectRuntimeLock } from "../scripts/sync-runtime.ts";
import { parseReleaseVersion, syncedReleaseVersion } from "../scripts/release-version.ts";

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
