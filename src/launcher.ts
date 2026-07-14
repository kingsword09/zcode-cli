import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hasNative, spawn as spawnPty } from "zigpty";

import { ensureUserConfig, readConfiguredModelAccess } from "./model-access.ts";
import {
  classifyZaiOAuthInvocation,
  runZaiOAuthLogin,
  type OfficialLoginPayload
} from "./zai-oauth.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = join(packageRoot, "vendor", "zcode.cjs");
const launcherPath = join(packageRoot, "bin", "zcode.js");
const NON_TUI_COMMANDS = new Set([
  "app-server",
  "commands",
  "doctor",
  "login",
  "logout",
  "plugins",
  "skills",
  "version"
]);
const NON_TUI_FLAGS = new Set([
  "-h",
  "--help",
  "-v",
  "--version",
  "-p",
  "--prompt",
  "--json",
  "--target"
]);
const FLAGS_WITH_VALUES = new Set([
  "-p",
  "--prompt",
  "--attach",
  "--cwd",
  "--disallowedTools",
  "--disallowed-tools",
  "--locale",
  "--mode",
  "--resume",
  "--target"
]);

export function isTuiInvocation(args: string[]): boolean {
  if (args.some((argument) => NON_TUI_FLAGS.has(argument))) return false;
  let command: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith("--") && argument.includes("=")) continue;
    if (FLAGS_WITH_VALUES.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) {
      command = argument;
      break;
    }
  }
  if (command === "tui") return true;
  return command ? !NON_TUI_COMMANDS.has(command) : true;
}

export function resolveNodeExecutable(): string {
  return process.env.ZCODE_NODE?.trim() || process.execPath;
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
  const merged: NodeJS.ProcessEnv = {
    ...env,
    ...extra,
    ZCODE_APP_CLI_EXECUTABLE: process.execPath,
    ZCODE_APP_CLI_ENTRY: launcherPath
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

async function runWithInheritedStdio(node: string, args: string[]): Promise<number> {
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
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    return await waitForChild(child);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

async function runInNativeTerminal(node: string, args: string[]): Promise<number> {
  if (!hasNative) {
    throw new Error("zigpty has no native binding for this platform. Reinstall zcode-app-cli on a supported target.");
  }
  const wasRaw = process.stdin.isRaw ?? false;
  const inputDecoder = new TextDecoder();
  const pty = spawnPty(node, [runtimePath, ...args], {
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
    cwd: process.cwd(),
    env: {
      ...runtimeEnvironment(),
      TERM: process.env.TERM ?? "xterm-256color"
    },
    name: process.env.TERM ?? "xterm-256color",
    encoding: null
  });
  const output = pty.onData((data) => process.stdout.write(data));

  const onInput = (data: Buffer | string) => {
    if (pty.exitCode === null) {
      pty.write(typeof data === "string" ? data : inputDecoder.decode(data, { stream: true }));
    }
  };
  const onResize = () => {
    if (pty.exitCode === null) {
      pty.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    }
  };
  const onSigint = () => pty.kill("SIGINT");
  const onSigterm = () => pty.kill("SIGTERM");

  try {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", onInput);
    process.stdout.on("resize", onResize);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    return await pty.exited;
  } finally {
    output.dispose();
    process.stdin.off("data", onInput);
    process.stdout.off("resize", onResize);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.stdin.setRawMode?.(wasRaw);
    if (!wasRaw) process.stdin.pause();
    pty.close();
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

  const interactive = isTuiInvocation(login.args) && process.stdin.isTTY && process.stdout.isTTY;
  try {
    return interactive ? await runInNativeTerminal(node, login.args) : await runWithInheritedStdio(node, login.args);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
