import { describe, expect, test } from "bun:test";

import { AppServerRequestError, requestAppServer } from "../src/app-server-client.ts";

const node = Bun.which("node");

function transport(script: string) {
  if (!node) throw new Error("Node.js is required for app-server client tests.");
  return {
    args: ["--input-type=module", "--eval", script],
    command: node,
    cwd: process.cwd(),
    env: process.env
  };
}

describe("app-server NDJSON client", () => {
  test("returns the matching response envelope", async () => {
    const script = `
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const request = JSON.parse(input.trim());
        console.log(JSON.stringify({ id: request.id, result: { method: request.method, params: request.params } }));
      });
    `;

    expect(await requestAppServer({
      method: "plugins/overview",
      params: { workspace: { workspacePath: "/tmp/project", workspaceKey: "/tmp/project" } },
      transport: transport(script)
    })).toEqual({
      method: "plugins/overview",
      params: { workspace: { workspacePath: "/tmp/project", workspaceKey: "/tmp/project" } }
    });
  });

  test("surfaces protocol errors with code and data", async () => {
    const script = `
      process.stdin.resume();
      process.stdin.on("end", () => console.log(JSON.stringify({
        id: 1,
        error: { code: -32602, message: "Invalid params", data: { field: "source" } }
      })));
    `;

    try {
      await requestAppServer({ method: "plugins/install", params: {}, transport: transport(script) });
      throw new Error("Expected request to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(AppServerRequestError);
      expect(error).toMatchObject({ code: -32602, data: { field: "source" } });
      expect((error as Error).message).toBe("Invalid params");
    }
  });

  test("rejects missing envelopes and honours cancellation", async () => {
    await expect(requestAppServer({
      method: "plugins/list",
      params: {},
      transport: transport("process.stdin.resume(); process.stdin.on('end', () => console.log('not-json')); ")
    })).rejects.toThrow(/did not return a response envelope/u);

    const controller = new AbortController();
    controller.abort();
    await expect(requestAppServer({
      method: "plugins/list",
      params: {},
      signal: controller.signal,
      transport: transport("")
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  test("finishes cancellation when the app-server ignores SIGTERM", async () => {
    const controller = new AbortController();
    const pending = requestAppServer({
      method: "plugins/list",
      params: {},
      signal: controller.signal,
      transport: transport(`
        process.on("SIGTERM", () => {});
        process.stdin.resume();
        setInterval(() => {}, 1000);
      `)
    });
    setTimeout(() => controller.abort(), 150);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  }, 3_000);
});
