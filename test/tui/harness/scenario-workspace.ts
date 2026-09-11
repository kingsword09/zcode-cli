import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { ScenarioJournal } from "./scenario-journal.ts";

const gitTimeoutMilliseconds = 10_000;

export interface ScenarioWorkspaceOptions {
  files?: Record<string, string | Uint8Array>;
  journal?: ScenarioJournal;
  prefix?: string;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ScenarioWorkspace implements AsyncDisposable {
  readonly root: string;
  readonly directory: string;
  readonly gitDirectory: string;
  readonly home: string;
  readonly journal: ScenarioJournal;
  readonly runtimeJournalPath: string;

  private constructor(root: string, journal: ScenarioJournal) {
    this.root = root;
    this.directory = join(root, "workspace");
    this.gitDirectory = join(root, "git");
    this.home = join(root, "home");
    this.journal = journal;
    this.runtimeJournalPath = join(root, "runtime.jsonl");
  }

  static async create(options: ScenarioWorkspaceOptions = {}): Promise<ScenarioWorkspace> {
    const root = await mkdtemp(join(tmpdir(), options.prefix ?? "zcode-tui-scenario-"));
    const workspace = new ScenarioWorkspace(root, options.journal ?? new ScenarioJournal());
    workspace.journal.record("workspace.create", { root });
    try {
      await mkdir(workspace.directory, { recursive: true });
      await mkdir(workspace.home, { recursive: true });
      for (const [path, contents] of Object.entries(options.files ?? {})) {
        await workspace.write(path, contents);
      }
      await workspace.git([
        "init",
        "--quiet",
        `--separate-git-dir=${workspace.gitDirectory}`,
        workspace.directory
      ], root);
      await workspace.git(["config", "user.name", "ZCode Scenario"]);
      await workspace.git(["config", "user.email", "scenario@zcode.invalid"]);
      await workspace.git(["config", "core.autocrlf", "false"]);
      const hooksDirectory = join(workspace.root, "hooks");
      await mkdir(hooksDirectory);
      await workspace.git(["config", "core.hooksPath", hooksDirectory]);
      await workspace.git(["config", "commit.gpgSign", "false"]);
      await workspace.git(["add", "--all"]);
      await workspace.git(["commit", "--quiet", "--allow-empty", "-m", "Scenario baseline"]);
      workspace.journal.record("workspace.ready", { directory: workspace.directory });
      return workspace;
    } catch (error) {
      await workspace.dispose();
      throw error;
    }
  }

  environment(): Record<string, string> {
    return {
      HOME: this.home,
      USERPROFILE: this.home,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      ZCODE_TUI_SCENARIO_RUNTIME_JOURNAL: this.runtimeJournalPath
    };
  }

  async write(path: string, contents: string | Uint8Array): Promise<void> {
    const destination = this.resolvePath(path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    this.journal.record("workspace.write", {
      path,
      bytes: typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength
    });
  }

  async read(path: string): Promise<string> {
    return await readFile(this.resolvePath(path), "utf8");
  }

  async readRuntimeJournal(): Promise<string> {
    return await readFile(this.runtimeJournalPath, "utf8").catch(() => "");
  }

  async git(args: string[], cwd = this.directory): Promise<GitCommandResult> {
    this.journal.record("git.start", { args, cwd });
    const child = Bun.spawn(["git", ...args], {
      cwd,
      env: {
        ...process.env,
        ...this.environment(),
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
        LC_ALL: "C"
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe"
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), gitTimeoutMilliseconds);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
      ]);
      const result = { stdout, stderr: stderr.trim(), exitCode };
      this.journal.record("git.finish", {
        args,
        exitCode,
        stdoutBytes: Buffer.byteLength(stdout),
        stderr: result.stderr
      });
      if (exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${result.stderr}`);
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async reset(): Promise<void> {
    await this.git(["reset", "--hard", "--quiet", "HEAD"]);
    await this.git(["clean", "-fdx", "--quiet"]);
    this.journal.record("workspace.reset", {});
  }

  private resolvePath(path: string): string {
    const destination = resolve(this.directory, path);
    if (destination !== this.directory && !destination.startsWith(`${this.directory}${sep}`)) {
      throw new Error(`Scenario path escapes the workspace: ${path}`);
    }
    return destination;
  }

  async dispose(): Promise<void> {
    this.journal.record("workspace.dispose", { root: this.root });
    await rm(this.root, { recursive: true, force: true });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}
