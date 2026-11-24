import { randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const managedDirectory = ".zcode/worktrees";
const bucketPattern = /^[0-9a-f]{4}$/u;
const bucketAttempts = 64;

export interface ManagedWorktree {
  bucket: string;
  path: string;
  cwd?: string;
  branch?: string;
  head: string;
  dirty: boolean;
}

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: directory,
    timeout: 10 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  });
  return stdout;
}

async function repositoryRoot(directory: string): Promise<string> {
  const checkout = (await git(directory, ["rev-parse", "--show-toplevel"])).trim();
  if (!checkout) throw new Error("The current directory is not inside a Git repository.");
  const worktrees = parseWorktreeRecords(await git(checkout, ["worktree", "list", "--porcelain", "-z"]));
  for (const record of worktrees.values()) {
    try {
      return await realpath(record.worktree);
    } catch {
      // The original checkout may have been removed while another Worktree remains.
    }
  }
  throw new Error("Unable to find an existing Git checkout.");
}

async function relativeWorkspaceDirectory(directory: string): Promise<string> {
  const checkout = await realpath((await git(directory, ["rev-parse", "--show-toplevel"])).trim());
  const workspace = await realpath(directory);
  const relativePath = relative(checkout, workspace);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)) {
    throw new Error("The active session directory is outside its Git checkout.");
  }
  return relativePath;
}

async function assertIgnored(root: string): Promise<void> {
  const managedPath = `${managedDirectory}/`;
  try {
    await git(root, ["check-ignore", "--quiet", "--", managedPath]);
    return;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== 1) throw error;
  }

  const excludePath = (await git(root, ["rev-parse", "--git-path", "info/exclude"])).trim();
  const excludeFile = isAbsolute(excludePath) ? excludePath : resolve(root, excludePath);
  let current = "";
  try {
    if ((await lstat(excludeFile)).isSymbolicLink()) {
      throw new Error("Refusing to update a symbolic link at Git's local exclude path.");
    }
    current = await readFile(excludeFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rule = "/.zcode/worktrees/";
  if (!current.split(/\r?\n/u).includes(rule)) {
    const separator = current && !current.endsWith("\n") ? "\n" : "";
    await mkdir(dirname(excludeFile), { recursive: true });
    await appendFile(excludeFile, `${separator}${rule}\n`);
  }
  try {
    await git(root, ["check-ignore", "--quiet", "--", managedPath]);
  } catch (error) {
    throw new Error("Unable to ignore the project-local Worktree directory.", { cause: error });
  }
}

async function ensureManagedRoot(root: string): Promise<string> {
  const zcodeDirectory = join(root, ".zcode");
  const managedRoot = join(root, managedDirectory);
  for (const directory of [zcodeDirectory, managedRoot]) {
    try {
      if ((await lstat(directory)).isSymbolicLink()) {
        throw new Error(`Refusing to use a symbolic link for ${relative(root, directory)}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(managedRoot, { recursive: true });
  const canonical = await realpath(managedRoot);
  const pathFromRoot = relative(root, canonical);
  if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || pathFromRoot.startsWith(sep)) {
    throw new Error("The managed worktree directory resolves outside the Git repository.");
  }
  return canonical;
}

async function allocateBucket(root: string): Promise<{ bucket: string; path: string }> {
  for (let attempt = 0; attempt < bucketAttempts; attempt += 1) {
    const bucket = randomBytes(2).toString("hex");
    const path = join(root, bucket);
    try {
      await mkdir(path);
      return { bucket, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to allocate a unique Worktree directory after 64 attempts.");
}

function parseWorktreeRecords(output: string): Map<string, Record<string, string>> {
  const records = new Map<string, Record<string, string>>();
  let current: Record<string, string> | undefined;
  for (const field of output.split("\0")) {
    if (!field) {
      if (current?.worktree) records.set(current.worktree, current);
      current = undefined;
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    current ??= {};
    current[key] = value;
  }
  if (current?.worktree) records.set(current.worktree, current);
  return records;
}

function bucketForPath(managedRoot: string, worktreePath: string): string | undefined {
  const pathFromRoot = relative(managedRoot, worktreePath);
  if (!pathFromRoot || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === "..") return undefined;
  const [bucket, name, ...rest] = pathFromRoot.split(sep);
  if (!bucket || !name || rest.length > 0 || !bucketPattern.test(bucket)) return undefined;
  return bucket;
}

export async function createManagedWorktree(directory: string): Promise<ManagedWorktree> {
  const root = await repositoryRoot(directory);
  await assertIgnored(root);
  const managedRoot = await ensureManagedRoot(root);
  const workspace = await relativeWorkspaceDirectory(directory);
  const head = (await git(directory, ["rev-parse", "HEAD"])).trim();
  const bucket = await allocateBucket(managedRoot);
  const worktreePath = join(bucket.path, basename(root));
  try {
    await git(root, ["worktree", "add", "--detach", worktreePath, head]);
    const canonicalWorktreePath = await realpath(worktreePath);
    const cwd = workspace
      ? await realpath(join(canonicalWorktreePath, workspace))
      : canonicalWorktreePath;
    return { bucket: bucket.bucket, path: canonicalWorktreePath, cwd, head, dirty: false };
  } catch (error) {
    await git(root, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
    await git(root, ["worktree", "prune"]).catch(() => undefined);
    await rm(bucket.path, { recursive: true, force: true });
    throw new Error(`Unable to create Worktree: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function listManagedWorktrees(directory: string): Promise<ManagedWorktree[]> {
  const root = await repositoryRoot(directory);
  const managedRoot = join(root, managedDirectory);
  const workspace = await relativeWorkspaceDirectory(directory);
  const output = await git(root, ["worktree", "list", "--porcelain", "-z"]);
  const records = parseWorktreeRecords(output);
  const worktrees: ManagedWorktree[] = [];
  for (const record of records.values()) {
    const worktreePath = record.worktree;
    const bucket = bucketForPath(managedRoot, worktreePath);
    if (!bucket || basename(worktreePath) !== basename(root)) continue;
    try {
      const dotGit = await lstat(join(worktreePath, ".git"));
      if (!dotGit.isFile()) continue;
      const status = await git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
      const cwd = workspace
        ? await realpath(join(worktreePath, workspace)).catch(() => undefined)
        : worktreePath;
      worktrees.push({
        bucket,
        path: worktreePath,
        ...(cwd ? { cwd } : {}),
        head: record.HEAD ?? "",
        ...(record.branch ? { branch: record.branch.replace(/^refs\/heads\//u, "") } : {}),
        dirty: status.length > 0
      });
    } catch {
      // A removed or incomplete entry is left for `git worktree prune`.
    }
  }
  return worktrees.sort((left, right) => left.bucket.localeCompare(right.bucket));
}

function freshSessionArguments(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--resume" || argument === "--continue" || argument === "-c") {
      if (argument !== "-c" && args[index + 1] && !args[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    if (argument.startsWith("--resume=") || argument.startsWith("--continue=")) continue;
    if (argument === "--cwd") {
      if (args[index + 1] && !args[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    if (argument.startsWith("--cwd=")) continue;
    result.push(argument);
  }
  return result;
}

/** Starts the extracted runtime in a fresh process so its session cwd is correct. */
export function restartTuiAtDirectory(directory: string): void {
  const runtimePath = process.argv[1];
  if (!runtimePath) throw new Error("Unable to locate the active ZCode runtime entrypoint.");
  const args = freshSessionArguments(process.argv.slice(2));
  setTimeout(() => {
    const child = spawn(process.execPath, [runtimePath, ...args], {
      cwd: directory,
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", (error) => {
      process.stderr.write(`Unable to start a session in ${directory}: ${error.message}\n`);
    });
    child.unref();
  }, 500);
}
