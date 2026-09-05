import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "zcode-preflight-races-"));
let output = "";
const decoder = new TextDecoder();
const terminal = new Bun.Terminal({
  cols: 120, rows: 35,
  data(terminal, data) {
    const text = decoder.decode(data, { stream: true });
    output += text;
    if (text.includes("\x1b[6n")) terminal.write("\x1b[1;1R");
  }
});
const child = Bun.spawn([process.execPath, join(import.meta.dir, "../test/fixtures/tui-preflight-races.ts")], {
  cwd: home,
  env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TERM: "xterm-256color", CI: "1" },
  terminal
});
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Missing ${label}: ${output.slice(-2000)}`);
}
const events = async () => (await readFile(join(home, "events.jsonl"), "utf8").catch(() => ""))
  .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
try {
  await waitFor(() => output.includes("glm-5.3-flash"), "editor");
  terminal.write("original input\r");
  await waitFor(async () => (await events()).some(event => event.check === 1), "pending validation");
  terminal.write("newer draft");
  await Bun.sleep(100);
  await writeFile(join(home, "release"), "");
  await waitFor(() => output.includes("PREFLIGHT_REJECTED_1"), "first rejection");
  terminal.write("\r");
  await waitFor(() => output.includes("PREFLIGHT_REJECTED_3"), "queued rejection");
  assert.deepEqual((await events()).filter(event => event.submitted).map(event => event.submitted), ["newer draft"]);
  terminal.write("retry trigger\r");
  await waitFor(async () => (await events()).filter(event => event.submitted).length === 3, "retained queue retry");
  assert.deepEqual((await events()).filter(event => event.submitted).map(event => event.submitted),
    ["newer draft", "retry trigger", "original input"]);
  terminal.write("/exit\r");
  await Promise.race([child.exited, Bun.sleep(2_000)]);
  assert.equal(child.exitCode, 0);
  console.log("PASS: actual TUI preserves newer draft and rejected queued input; zero model calls");
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
  terminal.close();
  await rm(home, { recursive: true, force: true });
}
