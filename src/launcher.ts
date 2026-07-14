import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readConfiguredModelAccess } from "./model-access.ts";
import {
  classifyZaiOAuthInvocation,
  runZaiOAuthLogin,
  type OfficialLoginPayload
} from "./zai-oauth.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = join(packageRoot, "vendor", "zcode.cjs");
const launcherPath = join(packageRoot, "bin", "zcode.ts");
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

export function resolveNodeExecutable(): string | null {
  if (process.env.ZCODE_NODE) return process.env.ZCODE_NODE;
  return Bun.which("node");
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

function runtimeEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ZCODE_CLI_OAUTH_CALLBACK_STDIN;
  return {
    ...env,
    ...extra,
    ZCODE_APP_CLI_BUN: process.execPath,
    ZCODE_APP_CLI_ENTRY: launcherPath
  };
}

async function runWithInheritedStdio(node: string, args: string[]): Promise<number> {
  const child = Bun.spawn([node, runtimePath, ...args], {
    cwd: process.cwd(),
    env: runtimeEnvironment(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });
  const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

async function runInNativeTerminal(node: string, args: string[]): Promise<number> {
  const wasRaw = process.stdin.isRaw ?? false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const terminal = new Bun.Terminal({
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
    name: process.env.TERM ?? "xterm-256color",
    data(_terminal, data) {
      process.stdout.write(data);
    }
  });

  const onInput = (data: Buffer | string) => {
    if (!terminal.closed) terminal.write(data);
  };
  const onResize = () => {
    if (!terminal.closed) {
      terminal.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    }
  };
  const onSigint = () => child?.kill("SIGINT");
  const onSigterm = () => child?.kill("SIGTERM");

  try {
    child = Bun.spawn([node, runtimePath, ...args], {
      cwd: process.cwd(),
      env: {
        ...runtimeEnvironment(),
        TERM: process.env.TERM ?? "xterm-256color"
      },
      terminal
    });

    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", onInput);
    process.stdout.on("resize", onResize);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    return await child.exited;
  } finally {
    process.stdin.off("data", onInput);
    process.stdout.off("resize", onResize);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.stdin.setRawMode?.(wasRaw);
    if (!wasRaw) process.stdin.pause();
    if (!terminal.closed) terminal.close();
  }
}

async function completeOfficialZaiLogin(
  node: string,
  payload: OfficialLoginPayload,
  runtimeArgs: string[],
  abortSignal: AbortSignal
): Promise<number> {
  if (abortSignal.aborted) return 130;
  const child = Bun.spawn([node, runtimePath, ...runtimeArgs], {
    cwd: process.cwd(),
    env: runtimeEnvironment({ ZCODE_CLI_OAUTH_CALLBACK_STDIN: "1" }),
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit"
  });
  const onAbort = () => child.kill("SIGINT");
  abortSignal.addEventListener("abort", onAbort, { once: true });
  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    return await child.exited;
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
  if (!node) {
    console.error(
      "ZCode's official runtime requires Node.js >=22.19. Set ZCODE_NODE or install Node.js."
    );
    return 1;
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

  const interactive = isTuiInvocation(login.args) && process.stdin.isTTY && process.stdout.isTTY;
  return interactive ? runInNativeTerminal(node, login.args) : runWithInheritedStdio(node, login.args);
}
