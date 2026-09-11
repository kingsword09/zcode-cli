import {
  Bash,
  ReadWriteFs,
  type BashOptions,
  type CommandName
} from "just-bash";

import { ScenarioRuntimeJournal } from "./scenario-runtime.ts";

const OUTPUT_JOURNAL_LIMIT = 16_384;
type ExecutionLimits = NonNullable<BashOptions["executionLimits"]>;

export const DEFAULT_SCENARIO_SHELL_COMMANDS = [
  "basename",
  "cat",
  "cp",
  "cut",
  "dirname",
  "echo",
  "find",
  "grep",
  "head",
  "jq",
  "ls",
  "mkdir",
  "mv",
  "printf",
  "pwd",
  "rm",
  "sed",
  "sort",
  "tail",
  "tee",
  "touch",
  "tr",
  "uniq",
  "wc"
] as const satisfies readonly CommandName[];

const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxCommandCount: 2_000,
  maxExecutionTimeMs: 5_000,
  maxInputBytes: 2 * 1024 * 1024,
  maxLoopIterations: 10_000,
  maxOutputSize: 2 * 1024 * 1024,
  maxSourceBytes: 256 * 1024,
  maxTraversalEntries: 20_000
};

export interface ScenarioShellDefinition {
  workspaceDirectory: string;
  commands?: readonly CommandName[];
  env?: Readonly<Record<string, string>>;
  executionLimits?: ExecutionLimits;
  journal?: ScenarioRuntimeJournal;
  journalPath?: string;
}

export interface ScenarioShellExecOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  expectedExitCode?: number | readonly number[];
  signal?: AbortSignal;
  stdin?: string;
}

export interface ScenarioShellResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface ScenarioShell {
  readonly journal: ScenarioRuntimeJournal;
  exec(command: string, options?: ScenarioShellExecOptions): Promise<ScenarioShellResult>;
}

function journalText(value: string): { text: string; truncated: boolean } {
  return {
    text: value.length > OUTPUT_JOURNAL_LIMIT
      ? `${value.slice(0, OUTPUT_JOURNAL_LIMIT)}…`
      : value,
    truncated: value.length > OUTPUT_JOURNAL_LIMIT
  };
}

function expectedExitCodes(value: number | readonly number[] | undefined): readonly number[] {
  const codes = value === undefined ? [0] : typeof value === "number" ? [value] : value;
  if (
    codes.length === 0
    || codes.some((code) => !Number.isSafeInteger(code) || code < 0 || code > 255)
  ) {
    throw new Error("Scenario shell expectedExitCode must contain valid exit codes.");
  }
  return codes;
}

export function createScenarioShell(definition: ScenarioShellDefinition): ScenarioShell {
  if (definition.journal && definition.journalPath) {
    throw new Error("Scenario shell accepts either journal or journalPath, not both.");
  }
  if (definition.commands?.length === 0) {
    throw new Error("Scenario shell requires at least one allowed command.");
  }

  const journal = definition.journal ?? new ScenarioRuntimeJournal(definition.journalPath);
  const commands = [...(definition.commands ?? DEFAULT_SCENARIO_SHELL_COMMANDS)];
  const shell = new Bash({
    commands,
    cwd: "/",
    // just-bash's Node module-loader patches are unavailable in Bun. The
    // scenario boundary instead keeps host commands, network, JS, and Python
    // disabled and roots every filesystem capability below the workspace.
    defenseInDepth: process.versions.bun ? false : { enabled: "auto" },
    env: {
      HOME: "/",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      ...definition.env
    },
    executionLimitProfile: "hardened",
    executionLimits: {
      ...DEFAULT_EXECUTION_LIMITS,
      ...definition.executionLimits
    },
    fs: new ReadWriteFs({
      root: definition.workspaceDirectory,
      allowSymlinks: false,
      maxCopyOnWriteSize: 16 * 1024 * 1024,
      maxCopySize: 16 * 1024 * 1024,
      maxFileReadSize: 16 * 1024 * 1024
    }),
    javascript: false,
    python: false
  });
  journal.record("shell.create", { commands, workspaceDirectory: definition.workspaceDirectory });

  return {
    journal,
    async exec(command: string, options: ScenarioShellExecOptions = {}): Promise<ScenarioShellResult> {
      const expected = expectedExitCodes(options.expectedExitCode);
      journal.record("shell.start", {
        command,
        cwd: options.cwd ?? "/",
        expectedExitCodes: expected,
        stdinBytes: Buffer.byteLength(options.stdin ?? "")
      });
      try {
        const result = await shell.exec(command, {
          cwd: options.cwd ?? "/",
          env: options.env ? { ...options.env } : undefined,
          signal: options.signal,
          stdin: options.stdin
        });
        const publicResult = {
          exitCode: result.exitCode,
          stderr: result.stderr,
          stdout: result.stdout
        };
        journal.record("shell.finish", {
          exitCode: result.exitCode,
          stderr: journalText(result.stderr),
          stdout: journalText(result.stdout)
        });
        if (!expected.includes(result.exitCode)) {
          throw new Error(
            `Scenario shell expected exit ${expected.join(" or ")}, received ${result.exitCode}: ${result.stderr.trim()}`
          );
        }
        return publicResult;
      } catch (error) {
        journal.record("shell.error", {
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
  };
}
