import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createManagedWorktree, listManagedWorktrees } from "../../src/runtime-worktrees.ts";

const execFileAsync = promisify(execFile);

async function git(directory: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", directory, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ZCode Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "ZCode Test",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-worktree-"));
  await git(root, "init", "-q");
  await writeFile(join(root, ".gitignore"), ".zcode/\n");
  await writeFile(join(root, "README.md"), "fixture\n");
  await mkdir(join(root, "packages", "app"), { recursive: true });
  await writeFile(join(root, "packages", "app", "README.md"), "monorepo fixture\n");
  await git(root, "add", ".gitignore", "README.md", "packages/app/README.md");
  await git(root, "commit", "-qm", "initial commit");
  return root;
}

test("creates and lists desktop-compatible managed worktrees in the project", async () => {
  const root = await repository();
  try {
    const worktree = await createManagedWorktree(root);
    const canonicalRoot = await realpath(root);
    expect(worktree.bucket).toMatch(/^[0-9a-f]{4}$/u);
    expect(worktree.path).toBe(join(canonicalRoot, ".zcode", "worktrees", worktree.bucket, basename(canonicalRoot)));
    expect(worktree.cwd).toBe(worktree.path);
    expect(worktree.path.startsWith(join(canonicalRoot, ".zcode", "worktrees") + "/")).toBe(true);

    const worktrees = await listManagedWorktrees(root);
    expect(worktrees).toEqual([worktree]);
    expect((await gitRead(root, "status", "--short"))).toBe("");

    const child = await createManagedWorktree(worktree.path);
    expect(child.path).toBe(join(canonicalRoot, ".zcode", "worktrees", child.bucket, basename(canonicalRoot)));
    expect(child.cwd).toBe(child.path);
    expect((await listManagedWorktrees(worktree.path)).map((entry) => entry.bucket).sort())
      .toEqual([worktree.bucket, child.bucket].sort());

    expect(new Set((await listManagedWorktrees(root)).map((entry) => entry.bucket)))
      .toEqual(new Set([worktree.bucket, child.bucket]));

    const subdirectory = join(root, "packages", "app");
    const nestedWorktree = await createManagedWorktree(subdirectory);
    expect(nestedWorktree.cwd).toBe(join(nestedWorktree.path, "packages", "app"));
    expect((await listManagedWorktrees(subdirectory)).find((entry) => entry.bucket === nestedWorktree.bucket)?.cwd)
      .toBe(nestedWorktree.cwd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adds the managed Worktree directory to the local Git exclude file when needed", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-worktree-unignored-"));
  try {
    await git(root, "init", "-q");
    await git(root, "commit", "--allow-empty", "-qm", "initial commit");
    await writeFile(join(root, ".git", "info", "exclude"), "local-user-rule\n");
    const worktree = await createManagedWorktree(root);
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("local-user-rule");
    expect(exclude).toContain("/.zcode/worktrees/");
    expect(await gitRead(root, "status", "--short")).toBe("");
    expect(worktree.path).toContain("/.zcode/worktrees/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function gitRead(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...args]);
  return stdout.trim();
}
