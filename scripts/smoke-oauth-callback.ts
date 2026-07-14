#!/usr/bin/env bun

import { randomBytes } from "node:crypto";

import { createDarwinUrlCallbackReceiver } from "../src/darwin-oauth-callback.ts";

if (process.platform !== "darwin") {
  console.log("Native OAuth callback smoke test skipped outside macOS.");
  process.exit(0);
}

const nonce = randomBytes(8).toString("hex");
const scheme = `zcodeclitest${nonce}`;
const state = randomBytes(16).toString("hex");
const callbackUrl = `${scheme}://zai-auth/callback?code=smoke-code&state=${state}`;
const receiver = await createDarwinUrlCallbackReceiver({ scheme });

try {
  const child = Bun.spawn(["/usr/bin/open", callbackUrl], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe"
  });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text()
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `open exited with status ${code}`);
  const received = await receiver.waitForCallback(undefined, 10_000);
  if (received !== callbackUrl) throw new Error("Native callback URL did not round-trip exactly.");
} finally {
  await receiver.dispose();
}

console.log("Native macOS OAuth callback capture and handler restoration passed.");
