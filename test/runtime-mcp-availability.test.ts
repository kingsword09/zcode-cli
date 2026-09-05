import { describe, expect, test } from "bun:test";
import { patchRuntimeOfficialMcpAvailability } from "../scripts/sync-runtime.ts";

// This fixture preserves the minified upstream connection branch, with no network transport.
const source = `class Adapter {
  records = new Map();
  closed = [];
  connected = [];
  officialMcpAuth;
  createStatus(config,status,extra){return {status,...extra}}
  async closeRecord(name){this.closed.push(name)}
  async connectServer(t,r,n={}){if(await this.closeRecord(t),r.enabled===!1){let m=this.createStatus(r,"disabled");return this.records.set(t,{config:r,status:m,tools:[]}),m}this.connected.push(t);return {status:"connected"}}
}`;

function adapter() {
  return new (new Function(`${patchRuntimeOfficialMcpAvailability(source)};return Adapter;`)())();
}

const official = {
  type: "http", auth: { type: "zcode_official", provider: "jwt_token" },
  official: { provider: "fixture" }, url: "https://example.invalid/mcp"
};

describe("official MCP runtime availability (offline)", () => {
  test("skips unavailable official HTTP services with an actionable status", async () => {
    const runtime = adapter();
    const result = await runtime.connectServer("image_search", official);
    expect(result).toMatchObject({ status: "disabled", failureKind: "official_auth_unavailable" });
    expect(result.error).toContain("authentication is unavailable");
    expect(runtime.connected).toEqual([]);
    expect(runtime.closed).toEqual(["image_search"]);
    expect(official).not.toHaveProperty("enabled");
  });

  test("allows revalidation after the runtime gains trusted-origin support", async () => {
    const runtime = adapter();
    await runtime.connectServer("image_search", official);
    runtime.officialMcpAuth = { trustedOrigins: {} };
    expect(await runtime.connectServer("image_search", official)).toEqual({ status: "connected" });
    expect(runtime.connected).toEqual(["image_search"]);
  });

  test("preserves explicit disablement and other transports/auth paths", async () => {
    const runtime = adapter();
    expect(await runtime.connectServer("disabled", { ...official, enabled: false })).toEqual({ status: "disabled" });
    for (const config of [{ type: "http" }, { ...official, type: "stdio" }, { ...official, official: undefined }]) {
      expect(await runtime.connectServer("other", config)).toEqual({ status: "connected" });
    }
  });

  test("is idempotent and rejects missing or ambiguous patch anchors", () => {
    const patched = patchRuntimeOfficialMcpAvailability(source);
    expect(patchRuntimeOfficialMcpAvailability(patched)).toBe(patched);
    expect(() => patchRuntimeOfficialMcpAvailability("changed upstream")).toThrow("incompatible");
    expect(() => patchRuntimeOfficialMcpAvailability(source + source)).toThrow("incompatible");
  });
});
