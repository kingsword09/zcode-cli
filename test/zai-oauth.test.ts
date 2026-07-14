import { describe, expect, test } from "bun:test";

import {
  buildZaiAuthorizeUrl,
  parseZaiOAuthCallback,
  runZaiOAuthLogin
} from "../src/zai-oauth.ts";

describe("Z.AI Desktop OAuth bridge", () => {
  test("builds the registered Desktop authorization request", () => {
    const url = new URL(buildZaiAuthorizeUrl("expected-state"));
    expect(`${url.origin}${url.pathname}`).toBe("https://chat.z.ai/api/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
    expect(url.searchParams.get("redirect_uri")).toBe("zcode://zai-auth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("expected-state");
  });

  test("accepts only the registered callback with the expected state", () => {
    const callback = "zcode://zai-auth/callback?code=authorization-code&state=expected-state";
    expect(parseZaiOAuthCallback(callback, "expected-state")).toEqual({
      callbackUrl: callback,
      code: "authorization-code",
      state: "expected-state"
    });
    expect(() => parseZaiOAuthCallback(
      "zcode://zai-auth/callback?code=authorization-code&state=wrong",
      "expected-state"
    )).toThrow(/state did not match/);
    expect(() => parseZaiOAuthCallback(
      "http://127.0.0.1/callback?code=authorization-code&state=expected-state",
      "expected-state"
    )).toThrow(/unexpected OAuth callback target/);
    expect(() => parseZaiOAuthCallback(
      "zcode://zai-auth/callback?error=access_denied&state=expected-state",
      "expected-state"
    )).toThrow(/access_denied/);
    expect(() => parseZaiOAuthCallback(
      "zcode://zai-auth/callback?error=forged-error&state=wrong",
      "expected-state"
    )).toThrow(/state did not match/);
  });

  test("restores the protocol receiver before handing the callback to the official runtime", async () => {
    const events: string[] = [];
    let output = "";
    const callbackUrl = "zcode://zai-auth/callback?code=private-code&state=expected-state";
    const code = await runZaiOAuthLogin({
      completeLogin: async (payload, runtimeArgs) => {
        events.push("complete");
        expect(events).toEqual(["open", "wait", "dispose", "complete"]);
        expect(payload).toEqual({ callbackUrl, state: "expected-state" });
        expect(runtimeArgs).toEqual(["login"]);
        return 0;
      },
      createReceiver: async ({ scheme }) => {
        expect(scheme).toBe("zcode");
        return {
          async dispose() {
            events.push("dispose");
          },
          async waitForCallback() {
            events.push("wait");
            return callbackUrl;
          }
        };
      },
      invocation: { json: false, noBrowser: false, runtimeArgs: ["login"] },
      openBrowser: async () => {
        events.push("open");
        return { opened: true };
      },
      output: { write(value) { output += value; } },
      platform: "darwin",
      state: "expected-state"
    });

    expect(code).toBe(0);
    expect(output).toContain("Opening browser for Z.AI authorization");
    expect(output).toContain("Authorization received");
    expect(output).not.toContain("private-code");
    expect(events.filter((event) => event === "dispose")).toHaveLength(1);
  });

  test("supports manual browser opening without invoking the opener", async () => {
    const callbackUrl = "zcode://zai-auth/callback?code=code&state=expected-state";
    let output = "";
    const code = await runZaiOAuthLogin({
      completeLogin: async () => 0,
      createReceiver: async () => ({
        async dispose() {},
        async waitForCallback() { return callbackUrl; }
      }),
      invocation: {
        json: false,
        noBrowser: true,
        runtimeArgs: ["login", "--no-browser"]
      },
      openBrowser: async () => {
        throw new Error("browser opener should not run");
      },
      output: { write(value) { output += value; } },
      platform: "darwin",
      state: "expected-state"
    });

    expect(code).toBe(0);
    expect(output).toContain("Open this URL to sign in");
  });

  test("fails clearly on platforms that cannot receive the registered callback", async () => {
    expect(runZaiOAuthLogin({
      completeLogin: async () => 0,
      invocation: { json: false, noBrowser: false, runtimeArgs: ["login"] },
      platform: "linux"
    })).rejects.toThrow(/requires macOS/);
  });
});
