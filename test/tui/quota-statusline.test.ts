import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveQuotaStatusline } from "../../packages/zcode-tui/src/quota-statusline.ts";

test("ui.quotaStatusline defaults to off and only accepts an explicit boolean", () => {
  expect(resolveQuotaStatusline({})).toBe(false);
  expect(resolveQuotaStatusline({ ui: {} })).toBe(false);
  expect(resolveQuotaStatusline({ ui: { quotaStatusline: false } })).toBe(false);
  expect(resolveQuotaStatusline({ ui: { quotaStatusline: "yes" } })).toBe(false);
  expect(resolveQuotaStatusline({ ui: { quotaStatusline: 1 } })).toBe(false);
});

test("ui.quotaStatusline enables with an explicit boolean", () => {
  expect(resolveQuotaStatusline({ ui: { quotaStatusline: true } })).toBe(true);
});

test("readQuotaStatusline reads the isolated settings file and survives unreadable configs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-quota-setting-"));
  const settingsFile = join(dir, "setting.json");
  writeFileSync(settingsFile, JSON.stringify({ ui: { quotaStatusline: true } }));
  expect(await resolveQuotaStatusline({})).toBe(false);
  const { readQuotaStatusline } = await import("../../packages/zcode-tui/src/quota-statusline.ts");
  expect(await readQuotaStatusline({ ZCODE_CLI_SETTINGS_FILE: settingsFile })).toBe(true);
  writeFileSync(settingsFile, "{ not json");
  expect(await readQuotaStatusline({ ZCODE_CLI_SETTINGS_FILE: settingsFile })).toBe(false);
});
