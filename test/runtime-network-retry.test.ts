import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureProcesses: ChildProcessWithoutNullStreams[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureProcesses.splice(0).map(async (child) => {
    if (child.exitCode !== null) return;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    await closed;
  }));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function startFixtureServer(
  node: string,
  fixture = "network-reset-server.mjs",
  env: NodeJS.ProcessEnv = process.env
): Promise<{
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  port: number;
  stderr: () => string;
}> {
  const child = spawn(node, [join(root, "test", "fixtures", fixture)], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  fixtureProcesses.push(child as ChildProcessWithoutNullStreams);
  let output = "";
  let errorOutput = "";
  let pending = "";
  let ready = false;
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Network fixture server did not start. ${errorOutput}`)), 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      pending += text;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        const match = /^READY (\d+)$/u.exec(line);
        if (match?.[1] && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (ready) return;
      clearTimeout(timer);
      reject(new Error(`Network fixture server exited with ${code}. ${errorOutput}`));
    });
  });
  return {
    child: child as ChildProcessWithoutNullStreams,
    output: () => output,
    port,
    stderr: () => errorOutput
  };
}

interface RuntimeOutputEntry {
  payload?: Record<string, unknown>;
  response?: string;
  type?: string;
}

async function runNetworkFixture(options: {
  fixture?: string;
  keepAlive?: boolean;
  modelRetries?: number;
  providerName: string;
  serverEnv?: Record<string, string>;
  temporaryPrefix: string;
}): Promise<{
  code: number;
  diagnostics: string;
  output: RuntimeOutputEntry[];
  requestCount: number;
  stdout: string;
}> {
  const node = Bun.which("node");
  if (!node) throw new Error("Node.js is required for runtime retry integration tests.");
  const server = await startFixtureServer(node, options.fixture, {
    ...process.env,
    ...options.serverEnv
  });
  const home = await mkdtemp(join(tmpdir(), options.temporaryPrefix));
  temporaryDirectories.push(home);
  const workspace = join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  const config = await Bun.file(new URL("../config.example.json", import.meta.url)).json() as {
    features: Record<string, unknown>;
    logging: Record<string, unknown>;
    mcp: { servers: Record<string, unknown> };
    memory: Record<string, unknown>;
    model: Record<string, unknown>;
    plugins: Record<string, unknown>;
    provider: Record<string, unknown>;
    skills: Record<string, unknown>;
    storage: Record<string, unknown>;
  };
  const defaultZai = config.provider.zai as { models: Record<string, unknown> };
  config.provider.zai = {
    kind: "openai-compatible",
    name: options.providerName,
    options: {
      apiKey: "fixture-key",
      apiKeyRequired: true,
      baseURL: `http://127.0.0.1:${server.port}/v1`
    },
    headers: {},
    models: defaultZai.models
  };
  config.model = { main: "zai/glm-5.2", lite: "zai/glm-5.2" };
  config.storage = {
    dir: join(home, ".zcode"),
    sessionDbPath: join(home, ".zcode", "cli", "db", "db.sqlite")
  };
  config.features = {
    compact: false,
    rewind: false,
    subagent: false,
    memory: false,
    skill: false,
    mcp: false
  };
  config.memory = { use: false, write: false, autoConsolidate: false };
  config.plugins = {
    enabled: false,
    dirs: [],
    enabledPlugins: {},
    options: {},
    suppressedBuiltins: []
  };
  config.skills = { enabled: false, includeInstructions: false, metadataBudget: 20_000, roots: [] };
  config.mcp = { servers: {} };
  config.logging = { level: "error", format: "text" };
  const configDirectory = join(home, ".zcode", "cli");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const runtimeArgs = [
    ...(options.keepAlive === false
      ? []
      : ["--import", join(root, "test", "fixtures", "runtime-keepalive.mjs")]),
    "vendor/zcode.cjs",
    "--prompt",
    "Return the fixture response.",
    "--cwd",
    workspace,
    "--no-color",
    "--output-format",
    "stream-json",
    "--surface",
    "terminal",
    "--mode",
    "plan"
  ];
  const child = Bun.spawn([node, ...runtimeArgs], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NO_UPDATE_NOTIFIER: "1",
      ZCODE_DISABLE_UPDATE_CHECK: "1",
      ZCODE_MODEL_RETRY_BASE_DELAY_MS: "0",
      ZCODE_MODEL_RETRY_MAX_RETRIES: String(options.modelRetries ?? 1),
      ZCODE_NODE: node
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  const output = stdout.trim().split("\n").filter(Boolean).map(
    (line) => JSON.parse(line) as RuntimeOutputEntry
  );
  const serverOutput = server.output();
  return {
    code,
    diagnostics: `${stderr}\nserver:\n${serverOutput}${server.stderr()}`,
    output,
    requestCount: serverOutput.split("\n").filter((line) => line.startsWith("REQUEST ")).length,
    stdout
  };
}

test("recovers a real partial SSE connection reset without concatenating attempts", async () => {
  const run = await runNetworkFixture({
    providerName: "Retry fixture",
    temporaryPrefix: "zcode-network-retry-"
  });
  const result = run.output.findLast((entry) => entry.type === "result");
  const requestStarts = run.output.filter((entry) => entry.payload?.type === "model_request_started");

  expect(run.code, run.diagnostics).toBe(0);
  expect(run.requestCount, run.stdout).toBe(2);
  expect(requestStarts).toHaveLength(2);
  expect(requestStarts[1]?.payload?.streamRecovery).toMatchObject({ retryNumber: 1 });
  expect(result?.response).toBe("RECOVERED_FINAL");
  expect(result?.response).not.toContain("PARTIAL_SHOULD_BE_DISCARDED");
}, 30_000);

test("recovers a graceful mid-stream EOF that never reports a finish reason", async () => {
  const run = await runNetworkFixture({
    fixture: "network-eof-server.mjs",
    providerName: "EOF fixture",
    temporaryPrefix: "zcode-network-eof-"
  });
  const result = run.output.findLast((entry) => entry.type === "result");
  const requestStarts = run.output.filter((entry) => entry.payload?.type === "model_request_started");
  const failures = run.output.filter((entry) => entry.payload?.type === "model_request_failed");
  const completions = run.output.filter((entry) => entry.payload?.type === "model_request_completed");

  expect(run.code, run.diagnostics).toBe(0);
  expect(run.requestCount, run.stdout).toBe(2);
  expect(requestStarts).toHaveLength(2);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.payload?.reason).toBe("stream_idle_timeout");
  expect(completions).toHaveLength(1);
  expect(result?.response).toBe("RECOVERED_FINAL");
  expect(result?.response).not.toContain("PARTIAL_SHOULD_BE_DISCARDED");
}, 30_000);

test("exits unsuccessfully when graceful EOF recovery is exhausted", async () => {
  const run = await runNetworkFixture({
    fixture: "network-eof-server.mjs",
    keepAlive: false,
    modelRetries: 0,
    providerName: "EOF exhaustion fixture",
    serverEnv: { ZCODE_TEST_ALWAYS_EOF: "1" },
    temporaryPrefix: "zcode-network-eof-exhausted-"
  });
  const failures = run.output.filter((entry) => entry.payload?.type === "model_request_failed");
  const completions = run.output.filter((entry) => entry.payload?.type === "model_request_completed");
  const recoveryRetries = run.output.filter((entry) => (
    entry.type === "streamRecovery.updated"
    && entry.payload?.streamMode === "sse"
    && typeof entry.payload.retryNumber === "number"
  ));
  const finalRecovery = recoveryRetries.at(-1)?.payload;

  expect(run.code, run.diagnostics).not.toBe(0);
  expect(run.requestCount).toBeGreaterThan(1);
  expect(failures).toHaveLength(run.requestCount);
  expect(failures.every((entry) => entry.payload?.reason === "stream_idle_timeout")).toBe(true);
  expect(completions).toHaveLength(0);
  expect(run.output.some((entry) => entry.type === "result")).toBe(false);
  expect(run.output.some((entry) => entry.type === "turn.failed")).toBe(true);
  expect(recoveryRetries).toHaveLength(run.requestCount - 1);
  expect(finalRecovery?.retryNumber).toBe(finalRecovery?.maxRetries);
}, 30_000);
