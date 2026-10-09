import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { exchangeBigmodelOAuthCode } from "../src/bigmodel-oauth.ts";
import { hasRuntimeBigmodelOAuth, patchRuntimeBigmodelOAuth } from "../scripts/runtime-bigmodel-oauth-patches.ts";

const source = `
function label(fn){return fn}
const keys={bigmodelAccessToken:"access",zcodeJwtToken:"jwt"};
function client(options){return {buildAuthorizeUrl:({redirectUri,state})=>redirectUri+"?state="+state,exchangeCode:()=>{throw new Error("BigModel OAuth appSecret is required.")}}}
async function login(e={}){let http=e.httpClient,state=e.state,callback=e.callbackServer,oauth=client({httpClient:http}),url=oauth.buildAuthorizeUrl({redirectUri:callback.callbackUrl,state:state});try{let result=await callback.waitForCallback(),tokens=await oauth.exchangeCode({code:result.code});await e.credentialStore.saveMany({[keys.bigmodelAccessToken]:tokens.accessToken,other:"preserved"});return tokens}finally{await callback.close()}}
label(client,"createBigmodelOAuthClient");label(login,"loginBigmodelCodingPlan");
`;
const payload = { code: 0, data: { token: "fixture-jwt", bigmodel: { access_token: "fixture-access", refresh_token: "fixture-refresh" } } };
const input = { code: "fixture-code", state: "fixture-state", redirectUri: "http://127.0.0.1:12345/callback" };

function httpResponse(body: unknown, status = 200) {
  return { status, body: new TextEncoder().encode(JSON.stringify(body)) };
}

describe("BigModel Desktop token exchange", () => {
  test("sends the authorization context without an app secret and returns both token types", async () => {
    const controller = new AbortController(), trace = {};
    const result = await exchangeBigmodelOAuthCode({ ...input, abortSignal: controller.signal, trace,
      httpClient: { async request(request, signal) {
        expect(request).toMatchObject({ url: "https://zcode.z.ai/api/v1/oauth/token", method: "POST",
          headers: { "Content-Type": "application/json" }, maxResponseBytes: 65_536, trace });
        expect(signal).toBe(controller.signal);
        expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({
          provider: "bigmodel", code: input.code, state: input.state, redirect_uri: input.redirectUri
        });
        return httpResponse(payload);
      } }
    });
    expect(result).toEqual({ accessToken: "fixture-access", refreshToken: "fixture-refresh", zcodeJwtToken: "fixture-jwt" });
  });

  test.each([
    { bigmodel: { accessToken: " fixture-access ", refreshToken: " fixture-refresh " } },
    { access_token: "fixture-access" },
    { accessToken: "fixture-access" }
  ])("supports the token field variants accepted by Desktop (%j)", async data => {
    const result = await exchangeBigmodelOAuthCode({ ...input,
      httpClient: { request: async () => httpResponse({ data: { token: " fixture-jwt ", ...data } }) }
    });
    expect(result).toMatchObject({ accessToken: "fixture-access", zcodeJwtToken: "fixture-jwt" });
  });

  test.each([
    { body: { msg: "Expired authorization code" }, status: 401, error: "HTTP 401: Expired authorization code" },
    { body: { ...payload, code: 2007, msg: "Rejected" }, status: 200, error: "token exchange failed: Rejected" },
    { body: { data: { bigmodel: { access_token: "fixture-access" } } }, status: 200, error: "missing data.token" },
    { body: { data: { token: "fixture-jwt" } }, status: 200, error: "missing data.bigmodel.access_token" },
    { body: { data: { token: " ", bigmodel: { access_token: "fixture-access" } } }, status: 200, error: "missing data.token" }
  ])("rejects failed or incomplete exchanges (%j)", async ({ body, status, error }) => {
    await expect(exchangeBigmodelOAuthCode({ ...input,
      httpClient: { request: async () => httpResponse(body, status) }
    })).rejects.toThrow(error);
  });

  test("reports a non-JSON error response without echoing its body", async () => {
    await expect(exchangeBigmodelOAuthCode({ ...input,
      httpClient: { request: async () => ({ status: 502, body: new TextEncoder().encode("<html>gateway failure</html>") }) }
    })).rejects.toThrow("HTTP 502: token response is not valid JSON");
  });

  test("validates context and cancellation before making requests", async () => {
    let requests = 0;
    const httpClient = { request: async () => { requests++; return httpResponse(payload); } };
    for (const key of ["code", "state", "redirectUri"]) {
      await expect(exchangeBigmodelOAuthCode({ ...input, [key]: " ", httpClient })).rejects.toThrow("requires an authorization code");
    }
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(exchangeBigmodelOAuthCode({ ...input, httpClient, abortSignal: controller.signal })).rejects.toThrow("cancelled");
    expect(requests).toBe(0);
  });
});

describe("BigModel runtime patch", () => {
  test("replaces the failing exchange and persists the ZCode JWT alongside the provider token", async () => {
    const login = new Function("require", "__dirname", `${patchRuntimeBigmodelOAuth(source)};return login;`)(
      (id: string) => id === "node:path" ? { join } : { exchangeBigmodelOAuthCode }, "/fixture"
    );
    let closed = false, saved: unknown;
    const result = await login({ state: input.state, httpClient: { request: async () => httpResponse(payload) },
      callbackServer: { callbackUrl: input.redirectUri, waitForCallback: async () => ({ code: input.code }), close: async () => { closed = true; } },
      credentialStore: { saveMany: async (value: unknown) => { saved = value; } }
    });
    expect(result.accessToken).toBe("fixture-access");
    expect(saved).toEqual({ access: "fixture-access", jwt: "fixture-jwt", other: "preserved" });
    expect(closed).toBe(true);
  });

  test("patch is idempotent and rejects missing, ambiguous or partial anchors", () => {
    const patched = patchRuntimeBigmodelOAuth(source);
    expect(hasRuntimeBigmodelOAuth(source)).toBe(false);
    expect(hasRuntimeBigmodelOAuth(patched)).toBe(true);
    expect(patchRuntimeBigmodelOAuth(patched)).toBe(patched);
    for (const broken of ["incompatible runtime", source + source,
      source.replace("bigmodelAccessToken]:", "otherToken]:"),
      patched.replace("[keys.zcodeJwtToken]:tokens.zcodeJwtToken,", "")
    ]) {
      expect(hasRuntimeBigmodelOAuth(broken)).toBe(false);
      expect(() => patchRuntimeBigmodelOAuth(broken)).toThrow("incompatible with BigModel OAuth");
    }
  });
});
