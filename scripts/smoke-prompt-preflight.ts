import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "zcode-keyless-tui-"));
await mkdir(join(home, ".zcode", "cli"), { recursive: true });
await writeFile(join(home, ".zcode", "cli", "config.json"), JSON.stringify({
  provider: { zai: { kind: "anthropic", options: {
    apiKeyRequired: true, baseURL: "https://api.z.ai/api/anthropic"
  } } },
  model: { main: "zai/glm-5.3-flash" }
}));

let output = "";
const decoder = new TextDecoder();
const terminal = new Bun.Terminal({
  cols: 120, rows: 35,
  data(_terminal, data) { output += decoder.decode(data, { stream: true }); }
});
const child = Bun.spawn([process.execPath, join(import.meta.dir, "../test/fixtures/tui-keyless.ts")], {
  cwd: home,
  env: {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TERM: "xterm-256color", CI: "1",
    ZCODE_BASE_URL: "https://zcode.z.ai", ZCODE_MODEL_RETRY_MAX_RETRIES: "5"
  },
  terminal
});
async function waitFor(text: string) {
  const deadline = Date.now() + 5_000;
  while (!output.includes(text) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(25);
  assert(output.includes(text), `Missing ${text}: ${output.slice(-2000)}`);
}
try {
  await waitFor("glm-5.3-flash");
  terminal.write("offline fixture input\r");
  await waitFor("No model request was sent");
  assert(!output.includes("UNEXPECTED_MODEL_SUBMISSION"));
  terminal.write("\x15/exit\r");
  await Promise.race([child.exited, Bun.sleep(2_000)]);
  assert.equal(child.exitCode, 0);
  console.log("PASS: actual TUI rejects keyless Flash input before submitPrompt; zero model requests");
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
  terminal.close();
  await rm(home, { recursive: true, force: true });
}
