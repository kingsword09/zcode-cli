import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { UpdateAvailableView, releaseNotesUrl, updateCommand } from "../packages/zcode-tui/src/update-available-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import {
  availableUpdateVersion,
  readStartupUpdate,
  refreshUpdateCache,
  UPDATE_CACHE_TTL_MS,
  UPDATE_CHECK_URL,
  updateCachePath,
  updateCheckDisabled
} from "../src/update-check.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryCachePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-update-check-"));
  temporaryDirectories.push(directory);
  return join(directory, ".zcode", "cli", "version.json");
}

async function writeCache(
  cachePath: string,
  latestVersion: string,
  lastCheckedAt: number,
  checkedVersion?: string
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify({
    ...(checkedVersion ? { checkedVersion } : {}),
    latestVersion,
    lastCheckedAt: new Date(lastCheckedAt).toISOString()
  })}\n`);
}

describe("startup update check", () => {
  test("uses the cross-platform config directory and respects standard opt-outs", () => {
    expect(updateCachePath({ HOME: "/home/alice" }, "linux", "/fallback")).toBe(
      "/home/alice/.zcode/cli/version.json"
    );
    expect(updateCachePath({ USERPROFILE: "C:\\Users\\Alice" }, "win32", "C:\\fallback")).toBe(
      "C:\\Users\\Alice\\.zcode\\cli\\version.json"
    );
    expect(updateCheckDisabled({ CI: "true" })).toBe(true);
    expect(updateCheckDisabled({ NO_UPDATE_NOTIFIER: "1" })).toBe(true);
    expect(updateCheckDisabled({ ZCODE_DISABLE_UPDATE_CHECK: "yes" })).toBe(true);
    expect(updateCheckDisabled({ CI: "0", ZCODE_DISABLE_UPDATE_CHECK: "false" })).toBe(false);
  });

  test("shows a cached newer build without refreshing a fresh cache", async () => {
    const cachePath = await temporaryCachePath();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    await writeCache(cachePath, "3.3.5-2", now - 60_000, "3.3.5-1");

    await expect(readStartupUpdate({
      cachePath,
      currentVersion: "3.3.5-1",
      env: {},
      now
    })).resolves.toEqual({
      availableVersion: "3.3.5-2",
      cachePath,
      refreshRequired: false
    });
  });

  test("refreshes a fresh cache when the installed package version changes", async () => {
    const cachePath = await temporaryCachePath();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    await writeCache(cachePath, "3.3.5-1", now - 60_000, "3.3.5-1");

    await expect(readStartupUpdate({
      cachePath,
      currentVersion: "3.3.5-2",
      env: {},
      now
    })).resolves.toEqual({
      availableVersion: undefined,
      cachePath,
      refreshRequired: true
    });

    expect(availableUpdateVersion("3.3.5-2", "3.3.5-3")).toBe("3.3.5-3");
    expect(availableUpdateVersion("3.3.5-2", "3.3.5-2")).toBeUndefined();
    expect(availableUpdateVersion("invalid", "3.3.5-3")).toBeUndefined();
  });

  test("refreshes a legacy cache without checked package metadata once", async () => {
    const cachePath = await temporaryCachePath();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    await writeCache(cachePath, "3.3.5-1", now - 60_000);

    await expect(readStartupUpdate({
      cachePath,
      currentVersion: "3.3.5-1",
      env: {},
      now
    })).resolves.toMatchObject({ refreshRequired: true });
  });

  test("keeps a stale update visible while scheduling a background refresh", async () => {
    const cachePath = await temporaryCachePath();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    await writeCache(cachePath, "3.4.0-1", now - UPDATE_CACHE_TTL_MS - 1, "3.3.5-99");

    await expect(readStartupUpdate({
      cachePath,
      currentVersion: "3.3.5-99",
      env: {},
      now
    })).resolves.toEqual({
      availableVersion: "3.4.0-1",
      cachePath,
      refreshRequired: true
    });
    await expect(readStartupUpdate({
      cachePath,
      currentVersion: "invalid",
      env: {},
      now
    })).resolves.toBeUndefined();
  });

  test("refreshes the npm latest version into an atomic cache", async () => {
    const cachePath = await temporaryCachePath();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    let requestedUrl = "";

    await expect(refreshUpdateCache({
      cachePath,
      currentVersion: "3.3.5-1",
      fetcher: async (url, init) => {
        requestedUrl = url;
        expect(new Headers(init.headers).get("user-agent")).toBe("zcode-app-cli/3.3.5-1");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return new Response(JSON.stringify({ version: "3.3.5-2" }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      },
      now
    })).resolves.toBe("3.3.5-2");

    expect(requestedUrl).toBe(UPDATE_CHECK_URL);
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({
      checkedVersion: "3.3.5-1",
      latestVersion: "3.3.5-2",
      lastCheckedAt: "2026-07-14T12:00:00.000Z"
    });
    expect(await readStartupUpdate({
      cachePath,
      currentVersion: "3.3.5-1",
      env: {},
      now
    })).toMatchObject({ availableVersion: "3.3.5-2", refreshRequired: false });
  });

  test("rejects registry errors without replacing the existing cache", async () => {
    const cachePath = await temporaryCachePath();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    await writeCache(cachePath, "3.3.5-2", now - UPDATE_CACHE_TTL_MS - 1, "3.3.5-1");
    const before = await readFile(cachePath, "utf8");

    await expect(refreshUpdateCache({
      cachePath,
      currentVersion: "3.3.5-1",
      fetcher: async () => new Response("unavailable", { status: 503 }),
      now
    })).rejects.toThrow("HTTP 503");
    expect(await readFile(cachePath, "utf8")).toBe(before);
  });
});

describe("update available view", () => {
  test("renders the version transition, install command and release notes", () => {
    const output = new UpdateAvailableView(createTheme(false), "3.3.5-1", "3.3.5-2")
      .render(90)
      .join("\n");

    expect(output).toContain("✨ Update available! 3.3.5-1 → 3.3.5-2");
    expect(output).toContain(updateCommand);
    expect(output).toContain(releaseNotesUrl);
  });

  test("keeps the routine update notice free of a full-width background", () => {
    const output = new UpdateAvailableView(createTheme(true, "light"), "3.3.5-1", "3.3.5-2")
      .render(90)
      .join("\n");
    expect(output).not.toContain("\x1b[48;5;");
  });
});
