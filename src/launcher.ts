import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureUserConfig, readConfiguredModelAccess, userConfigPath } from "./model-access.ts";
import {
  classifyZaiOAuthInvocation,
  runZaiOAuthLogin,
  type OfficialLoginPayload
} from "./zai-oauth.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifestPath = join(packageRoot, "package.json");
const extractionMetadataPath = join(packageRoot, "vendor", "extraction.json");
const runtimePath = join(packageRoot, "vendor", "zcode.cjs");
const launcherPath = join(packageRoot, "bin", "zcode.js");
const defaultModelRetryMaxRetries = "5";
const versionArguments = new Set(["version", "--version", "-v"]);

export function resolveModelRetryMaxRetries(env: NodeJS.ProcessEnv): string {
  return env.ZCODE_MODEL_RETRY_MAX_RETRIES?.trim() || defaultModelRetryMaxRetries;
}

export function resolveNodeExecutable(): string {
  return process.env.ZCODE_NODE?.trim() || process.execPath;
}

function safeVersion(value: unknown): string | undefined {
  const version = typeof value === "string" ? value.trim() : "";
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(version) ? version : undefined;
}

function readJsonVersion(path: string, key: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return safeVersion(value[key]);
  } catch {
    return undefined;
  }
}

export function readDistributionVersion(manifestPath = packageManifestPath): string | undefined {
  return readJsonVersion(manifestPath, "version");
}

export function readRuntimeVersion(metadataPath = extractionMetadataPath): string | undefined {
  return readJsonVersion(metadataPath, "cliVersion");
}

export function isVersionInvocation(args: string[]): boolean {
  return args.length === 1 && versionArguments.has(args[0]!);
}

export function formatVersionOutput(distributionVersion: string, runtimeVersion: string): string {
  return [
    `zcode-app-cli ${safeVersion(distributionVersion) ?? "unknown"}`,
    `zcode-runtime ${safeVersion(runtimeVersion) ?? "unknown"}`
  ].join("\n");
}

export function normalizeLoginArgs(args: string[]): { args: string[]; checkConfiguredAccess: boolean } {
  if (args.length === 1 && args[0] === "login") {
    return { args, checkConfiguredAccess: true };
  }
  if (args[0] === "login" && args.includes("--oauth")) {
    return { args: args.filter((argument) => argument !== "--oauth"), checkConfiguredAccess: false };
  }
  return { args, checkConfiguredAccess: false };
}

function runtimeEnvironment(extra: NodeJS.ProcessEnv = {}): Record<string, string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ZCODE_CLI_OAUTH_CALLBACK_STDIN;
  const distributionVersion = readDistributionVersion();
  const inherited: NodeJS.ProcessEnv = {
    ...env,
    ...extra
  };
  const merged: NodeJS.ProcessEnv = {
    ...inherited,
    ZCODE_MODEL_RETRY_MAX_RETRIES: resolveModelRetryMaxRetries(inherited),
    ZCODE_APP_CLI_EXECUTABLE: process.execPath,
    ZCODE_APP_CLI_ENTRY: launcherPath,
    ...(distributionVersion ? { ZCODE_APP_CLI_VERSION: distributionVersion } : {})
  };
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const number = (osConstants.signals as Record<string, number>)[signal];
  return typeof number === "number" ? 128 + number : 1;
}

async function waitForChild(child: ChildProcess): Promise<number> {
  return await new Promise((resolveExit) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolveExit(code);
    };
    child.once("error", (error) => {
      console.error(`Error: ${error.message}`);
      finish(1);
    });
    child.once("exit", (code, signal) => finish(code ?? signalExitCode(signal)));
  });
}

export const defaultModel = "zai/glm-5.2";

interface ParsedOption {
  value: string;
  indexes: number[];
}

function parseOption(args: string[], name: string): ParsedOption | undefined {
  const matches: ParsedOption[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === name) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} requires a non-empty value`);
      }
      matches.push({ value, indexes: [index, index + 1] });
      index += 1;
      continue;
    }
    if (argument.startsWith(`${name}=`)) {
      const value = argument.slice(name.length + 1);
      if (!value) throw new Error(`${name} requires a non-empty value`);
      matches.push({ value, indexes: [index] });
    }
  }
  if (matches.length > 1) throw new Error(`${name} may be specified only once`);
  return matches[0];
}

export async function prepareModelOverride(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ args: string[]; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const modelOption = parseOption(args, "--model");
  if (modelOption === undefined) return { args, env: {}, cleanup: async () => {} };
  const settingsOption = parseOption(args, "--settings");
  const model = modelOption.value.trim();
  if (!model) throw new Error("--model requires a non-empty provider/model identifier");
  const sourcePath = settingsOption?.value ?? userConfigPath(env);
  const config = JSON.parse(await readFile(sourcePath, "utf8")) as Record<string, unknown>;
  const modelConfig = config.model && typeof config.model === "object" && !Array.isArray(config.model)
    ? { ...(config.model as Record<string, unknown>) }
    : {};
  modelConfig.main = model;
  config.model = modelConfig;
  const directory = await mkdtemp(join(tmpdir(), "zcode-settings-"));
  const configPath = join(directory, ".zcode", "cli", "config.json");
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600);
  const removedIndexes = new Set([...modelOption.indexes, ...(settingsOption?.indexes ?? [])]);
  const runtimeArgs = args.filter((_, index) => !removedIndexes.has(index));
  return {
    args: runtimeArgs,
    env: { HOME: directory, USERPROFILE: directory },
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

interface ODWResultEnvelope {
  type: "zcode_result";
  text: string;
  stderr: string;
  exitCode: number;
  sessionId: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  telemetryAvailable: boolean;
}

async function readChildText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runProtocolRuntime(node: string, args: string[]): Promise<number> {
  const prepared = await prepareModelOverride(args);
  const child = spawnChild(node, [runtimePath, ...prepared.args], {
    cwd: process.cwd(),
    env: runtimeEnvironment(prepared.env),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const [stdout, stderr, code] = await Promise.all([
    readChildText(child.stdout),
    readChildText(child.stderr),
    waitForChild(child)
  ]);
  const envelope: ODWResultEnvelope = {
    type: "zcode_result",
    text: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
    exitCode: code,
    sessionId: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    telemetryAvailable: false
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  await prepared.cleanup();
  return code;
}

async function runRuntime(node: string, args: string[]): Promise<number> {
  if (process.env.ZCODE_ODW_PROTOCOL === "1") {
    return runProtocolRuntime(node, args);
  }
  const prepared = await prepareModelOverride(args);
  const child = spawnChild(node, [runtimePath, ...prepared.args], {
    cwd: process.cwd(),
    env: runtimeEnvironment(prepared.env),
    stdio: "inherit"
  });
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  const onSighup = () => forwardSignal("SIGHUP");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  if (process.platform !== "win32") process.once("SIGHUP", onSighup);
  try {
    return await waitForChild(child);
  } finally {
    await prepared.cleanup();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (process.platform !== "win32") process.off("SIGHUP", onSighup);
  }
}

async function completeOfficialZaiLogin(
  node: string,
  payload: OfficialLoginPayload,
  runtimeArgs: string[],
  abortSignal: AbortSignal
): Promise<number> {
  if (abortSignal.aborted) return 130;
  const child = spawnChild(node, [runtimePath, ...runtimeArgs], {
    cwd: process.cwd(),
    env: runtimeEnvironment({ ZCODE_CLI_OAUTH_CALLBACK_STDIN: "1" }),
    stdio: ["pipe", "inherit", "inherit"]
  });
  const onAbort = () => child.kill("SIGINT");
  abortSignal.addEventListener("abort", onAbort, { once: true });
  try {
    child.stdin?.end(JSON.stringify(payload));
    return await waitForChild(child);
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }
}

export async function main(args: string[]): Promise<number> {
  if (!existsSync(runtimePath)) {
    console.error(
      "ZCode runtime is missing. Reinstall the package or run `bun run sync:local` in the source checkout."
    );
    return 1;
  }

  if (isVersionInvocation(args)) {
    const distributionVersion = readDistributionVersion();
    const runtimeVersion = readRuntimeVersion();
    if (!distributionVersion || !runtimeVersion) {
      console.error("Unable to read npm package or bundled runtime version metadata.");
      return 1;
    }
    console.log(formatVersionOutput(distributionVersion, runtimeVersion));
    return 0;
  }

  try {
    await ensureUserConfig();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const login = normalizeLoginArgs(args);
  const zaiOAuth = classifyZaiOAuthInvocation(args);
  if (login.checkConfiguredAccess) {
    const access = await readConfiguredModelAccess();
    if (access) {
      console.log(
        `Model access is already configured for ${access.model}; OAuth login is not required.\n`
        + `Config: ${access.configPath}\n`
        + "Run `zcode login --oauth` to force Z.AI OAuth."
      );
      return 0;
    }
  }

  const node = resolveNodeExecutable();


  if (zaiOAuth) {
    const abortController = new AbortController();
    const cancel = () => abortController.abort(new Error("Login cancelled."));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      return await runZaiOAuthLogin({
        abortSignal: abortController.signal,
        completeLogin: (payload, runtimeArgs) => completeOfficialZaiLogin(
          node,
          payload,
          runtimeArgs,
          abortController.signal
        ),
        invocation: zaiOAuth,
        output: zaiOAuth.json ? process.stderr : process.stdout
      });
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return abortController.signal.aborted ? 130 : 1;
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }

  try {
    return await runRuntime(node, login.args);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
