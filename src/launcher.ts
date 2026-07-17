import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureUserConfig, readConfiguredModelAccess } from "./model-access.ts";
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

async function runRuntime(node: string, args: string[]): Promise<number> {
  const child = spawnChild(node, [runtimePath, ...args], {
    cwd: process.cwd(),
    env: runtimeEnvironment(),
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
