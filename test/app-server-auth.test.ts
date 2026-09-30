import { expect, test } from "bun:test";
import { appServerAuthMode, appServerRegistryOptions } from "../src/app-server-auth.ts";

test("standalone mode reuses the native credential loader and refresh reporter", () => {
  const reporter = { onBuiltinRefreshError() {} };
  expect(appServerAuthMode({})).toBe("standalone");
  expect(appServerRegistryOptions({}, stderr => {
    expect(stderr).toBe(process.stderr);
    return reporter;
  })).toEqual({ standalone: reporter });
});

test("explicit host mode never enables local credentials or invokes their reporter", () => {
  expect(appServerRegistryOptions({ ZCODE_APP_SERVER_AUTH_MODE: " host " }, () => {
    throw new Error("host mode must not initialize standalone auth");
  })).toEqual({});
});

test("invalid auth modes fail instead of falling back to another account", () => {
  expect(() => appServerRegistryOptions({ ZCODE_APP_SERVER_AUTH_MODE: "hosst" }, () => ({})))
    .toThrow("ZCODE_APP_SERVER_AUTH_MODE must be standalone or host");
});
