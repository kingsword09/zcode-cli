import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = join(packageRoot, "vendor", "zcode.cjs");
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

async function runWithInheritedStdio(node: string, args: string[]): Promise<number> {
  const child = Bun.spawn([node, runtimePath, ...args], {
    cwd: process.cwd(),
    env: process.env,
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
        ...process.env,
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

export async function main(args: string[]): Promise<number> {
  if (!existsSync(runtimePath)) {
    console.error(
      "ZCode runtime is missing. Reinstall the package or run `bun run sync:local` in the source checkout."
    );
    return 1;
  }

  const node = resolveNodeExecutable();
  if (!node) {
    console.error(
      "ZCode's official runtime requires Node.js >=22.19. Set ZCODE_NODE or install Node.js."
    );
    return 1;
  }

  const interactive = isTuiInvocation(args) && process.stdin.isTTY && process.stdout.isTTY;
  return interactive ? runInNativeTerminal(node, args) : runWithInheritedStdio(node, args);
}
