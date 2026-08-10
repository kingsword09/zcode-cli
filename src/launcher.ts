import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureUserConfig, readConfiguredModelAccess } from "./model-access.ts";
import {
  classifyZaiOAuthInvocation,
  runZaiOAuthLogin,
  type OfficialLoginPayload
} from "./zai-oauth.ts";
import { requestAppServer } from "./app-server-client.ts";
import { runPluginCommand } from "./plugin-cli.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifestPath = join(packageRoot, "package.json");
const extractionMetadataPath = join(packageRoot, "vendor", "extraction.json");
const runtimePath = join(packageRoot, "vendor", "zcode.cjs");
const launcherPath = join(packageRoot, "bin", "zcode.js");
const defaultModelRetryMaxRetries = "5";
const defaultBrowserUseArgument = "--browser-use=headless";
const tuiRuntimeLogLimitBytes = 2 * 1024 * 1024;
const versionArguments = new Set(["version", "--version", "-v"]);
const runtimeBooleanOptions = new Set([
  "--allow-main-worktree-yolo",
  "--continue",
  "--force",
  "--force-mcs",
  "--json",
  "--no-browser",
  "--no-color",
  "--stdio",
  "--target-replace",
  "--verbose"
]);
const runtimeValueOptions = new Set([
  "--allowed-tools",
  "--attach",
  "--browser-executable",
  "--cwd",
  "--locale",
  "--max-turns",
  "--mode",
  "--permission-mode",
  "--resume",
  "--settings"
]);
const runtimeVariadicOptions = new Set(["--disallowedTools", "--disallowed-tools"]);

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

function longOptionName(argument: string): string {
  const separator = argument.indexOf("=");
  return separator < 0 ? argument : argument.slice(0, separator);
}

interface RuntimeInvocationInspection {
  agentInvocation: boolean;
  command?: string;
  explicitBrowserUse: boolean;
  invalid: boolean;
  passthrough: boolean;
}

function inspectRuntimeInvocation(args: string[]): RuntimeInvocationInspection {
  let agentInvocation = false;
  let command: string | undefined;
  let explicitBrowserUse = false;
  let invalid = false;
  let passthrough = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") {
      command ??= args[index + 1];
      break;
    }
    if (argument.startsWith("--")) {
      const option = longOptionName(argument);
      const inlineValue = option.length !== argument.length;
      if (option === "--browser-use") {
        explicitBrowserUse = true;
        if (!inlineValue) {
          if (index + 1 >= args.length || args[index + 1]!.startsWith("-")) invalid = true;
          else index += 1;
        }
        continue;
      }
      if (option === "--help" || option === "--version") {
        passthrough = true;
        continue;
      }
      if (option === "--print") {
        if (inlineValue) invalid = true;
        else agentInvocation = true;
        continue;
      }
      if (option === "--prompt" || option === "--target") {
        agentInvocation = true;
        if (!inlineValue) {
          if (index + 1 >= args.length || args[index + 1]!.startsWith("-")) invalid = true;
          else index += 1;
        }
        continue;
      }
      if (runtimeVariadicOptions.has(option)) {
        if (!inlineValue) {
          const firstValue = index + 1;
          while (index + 1 < args.length && !args[index + 1]!.startsWith("-")) index += 1;
          if (index < firstValue) invalid = true;
        }
        continue;
      }
      if (runtimeValueOptions.has(option)) {
        if (!inlineValue) {
          if (index + 1 >= args.length || args[index + 1]!.startsWith("-")) invalid = true;
          else index += 1;
        }
        continue;
      }
      if (runtimeBooleanOptions.has(option) && !inlineValue) continue;
      invalid = true;
      continue;
    }
    if (argument.startsWith("-")) {
      if (argument === "-h" || argument === "-v") {
        passthrough = true;
        continue;
      }
      if (argument === "-p" || argument.startsWith("-p")) {
        agentInvocation = true;
        if (argument === "-p") {
          if (index + 1 >= args.length || args[index + 1]!.startsWith("-")) invalid = true;
          else index += 1;
        }
        continue;
      }
      if (argument === "-c" || argument === "-f") continue;
      invalid = true;
      continue;
    }
    command ??= argument;
  }

  return { agentInvocation, command, explicitBrowserUse, invalid, passthrough };
}

export function withDefaultBrowserUse(args: string[]): string[] {
  const invocation = inspectRuntimeInvocation(args);
  if (invocation.explicitBrowserUse
    || invocation.passthrough
    || invocation.invalid
    || (!invocation.agentInvocation
      && invocation.command !== undefined
      && invocation.command !== "tui")) return args;
  return [defaultBrowserUseArgument, ...args];
}

export function isTuiRuntimeInvocation(args: string[]): boolean {
  const invocation = inspectRuntimeInvocation(args);
  return !invocation.agentInvocation
    && !invocation.invalid
    && !invocation.passthrough
    && (invocation.command === undefined || invocation.command === "tui");
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

async function waitForChild(
  child: ChildProcess,
  onError: (error: Error) => void = (error) => console.error("Error: " + error.message)
): Promise<number> {
  return await new Promise((resolveExit) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolveExit(code);
    };
    child.once("error", (error) => {
      onError(error);
      finish(1);
    });
    child.once("exit", (code, signal) => finish(code ?? signalExitCode(signal)));
  });
}

interface TuiRuntimeDiagnosticState {
  bytes: number;
  initialized: boolean;
  path?: string;
  writeFailed: boolean;
}

function appendTuiRuntimeDiagnostic(chunk: Buffer | string, state: TuiRuntimeDiagnosticState): void {
  if (state.bytes >= tuiRuntimeLogLimitBytes) return;
  const text = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  try {
    const path = state.path ?? (process.env.ZCODE_TUI_RUNTIME_LOG?.trim()
      || join(homedir(), ".zcode", "cli", "tui-runtime.log"));
    state.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!state.initialized) {
      state.initialized = true;
      const existingBytes = existsSync(path) ? statSync(path).size : 0;
      if (existingBytes >= tuiRuntimeLogLimitBytes) {
        const rotated = `${path}.1`;
        if (existsSync(rotated)) unlinkSync(rotated);
        renameSync(path, rotated);
        chmodSync(rotated, 0o600);
      } else {
        state.bytes = existingBytes;
      }
    }
    const bounded = text.subarray(0, tuiRuntimeLogLimitBytes - state.bytes);
    if (bounded.byteLength === 0) return;
    appendFileSync(path, bounded, { mode: 0o600 });
    chmodSync(path, 0o600);
    state.bytes += bounded.byteLength;
  } catch {
    state.writeFailed = true;
  }
}

function tuiRuntimeFailureMessage(code: number, state: TuiRuntimeDiagnosticState): string {
  const diagnostic = state.path && !state.writeFailed
    ? ` Diagnostics: ${state.path}`
    : " Runtime diagnostics could not be written.";
  return `Error: ZCode runtime exited with status ${code}.${diagnostic}\n`;
}

async function runRuntime(node: string, args: string[]): Promise<number> {
  const tuiInvocation = isTuiRuntimeInvocation(args);
  const child = spawnChild(node, [runtimePath, ...args], {
    cwd: process.cwd(),
    env: runtimeEnvironment(),
    stdio: tuiInvocation ? ["inherit", "inherit", "pipe"] : "inherit"
  });
  const diagnosticState: TuiRuntimeDiagnosticState = {
    bytes: 0,
    initialized: false,
    writeFailed: false
  };
  const onDiagnostic = (chunk: Buffer | string) => appendTuiRuntimeDiagnostic(chunk, diagnosticState);
  child.stderr?.on("data", onDiagnostic);
  let forwardedSignal = false;
  const forwardSignal = (signal: NodeJS.Signals) => {
    forwardedSignal = true;
    if (!child.killed) child.kill(signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  const onSighup = () => forwardSignal("SIGHUP");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  if (process.platform !== "win32") process.once("SIGHUP", onSighup);
  try {
    const code = await waitForChild(
      child,
      tuiInvocation
        ? (error) => appendTuiRuntimeDiagnostic((error.stack ?? error.message) + "\n", diagnosticState)
        : undefined
    );
    if (tuiInvocation && code !== 0 && !forwardedSignal) {
      process.stderr.write(tuiRuntimeFailureMessage(code, diagnosticState));
    }
    return code;
  } finally {
    child.stderr?.off("data", onDiagnostic);
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

  const node = resolveNodeExecutable();
  const pluginAbortController = new AbortController();
  const cancelPluginCommand = () => pluginAbortController.abort();
  process.once("SIGINT", cancelPluginCommand);
  process.once("SIGTERM", cancelPluginCommand);
  let pluginCommand: number | undefined;
  try {
    pluginCommand = await runPluginCommand(args, {
      request: async ({ method, params, signal, workingDirectory }) => await requestAppServer({
        method,
        params,
        signal: signal ?? pluginAbortController.signal,
        transport: {
          args: [runtimePath, "app-server"],
          command: node,
          cwd: workingDirectory,
          env: runtimeEnvironment()
        }
      }),
      signal: pluginAbortController.signal
    });
  } finally {
    process.off("SIGINT", cancelPluginCommand);
    process.off("SIGTERM", cancelPluginCommand);
  }
  if (pluginCommand !== undefined) return pluginCommand;

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
    return await runRuntime(node, withDefaultBrowserUse(login.args));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
