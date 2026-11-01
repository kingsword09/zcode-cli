import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureCliSettings } from "../src/model-access.ts";
import { runtimeTestEnv } from "./runtime-test-env.ts";
import { terminalOutputText } from "./terminal-output.ts";

interface StartupSample {
  firstPaintMs?: number;
  loadingMs?: number;
  readyMs?: number;
}

const root = join(import.meta.dir, "..");
const node = process.env.ZCODE_NODE || Bun.which("node");
if (!node) throw new Error("Node.js is required to benchmark runtime startup.");
const runs = Number(process.argv[2] ?? 5);
if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
  throw new Error("Usage: bun scripts/bench-startup.ts [runs: 1..50]");
}
const home = await mkdtemp(join(tmpdir(), "zcode-startup-bench-"));
const env = { ...runtimeTestEnv(home, root), TERM: "xterm-256color" };
const samples: StartupSample[] = [];

try {
  await ensureCliSettings(env);
  for (let run = 0; run < runs; run++) {
    const sample: StartupSample = {};
    const started = performance.now();
    const decoder = new TextDecoder();
    let output = "";
    const terminal = new Bun.Terminal({
      cols: 100,
      rows: 32,
      data(_terminal, data) {
        output += decoder.decode(data, { stream: true });
        const text = terminalOutputText(output);
        const elapsed = Math.round(performance.now() - started);
        if (text.trim()) sample.firstPaintMs ??= elapsed;
        if (/Starting ZCode|正在启动 ZCode/u.test(text)) sample.loadingMs ??= elapsed;
        if (/◈ .*◉ /u.test(text)) sample.readyMs ??= elapsed;
      }
    });
    const child = Bun.spawn([node, join(root, "bin", "zcode.js")], {
      cwd: root,
      env,
      terminal
    });
    try {
      const deadline = performance.now() + 20_000;
      while (sample.readyMs === undefined && child.exitCode === null && performance.now() < deadline) {
        await Bun.sleep(10);
      }
      if (sample.readyMs === undefined) {
        throw new Error(`TUI did not become ready.\n${terminalOutputText(output).slice(-2_000)}`);
      }
      samples.push(sample);
    } finally {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await child.exited;
      } finally {
        clearTimeout(timeout);
        terminal.close();
      }
    }
  }
  const median = (key: keyof StartupSample) => {
    const values = samples.map(sample => sample[key]).filter((value): value is number => value !== undefined);
    values.sort((left, right) => left - right);
    const middle = Math.floor(values.length / 2);
    return values.length === 0 ? undefined : values.length % 2
      ? values[middle] : (values[middle - 1]! + values[middle]!) / 2;
  };
  console.log(JSON.stringify({
    node: Bun.spawnSync([node, "--version"]).stdout.toString().trim(),
    runs,
    samples,
    median: {
      firstPaintMs: median("firstPaintMs"),
      loadingMs: median("loadingMs"),
      readyMs: median("readyMs")
    }
  }, null, 2));
} finally {
  await rm(home, { recursive: true, force: true });
}
