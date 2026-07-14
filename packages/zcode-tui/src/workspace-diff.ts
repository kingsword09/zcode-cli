import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { parsePatch } from "diff";
import { resolve, sep } from "node:path";
import type { Readable } from "node:stream";

import type { FileDiffData, FileDiffHunk } from "./file-diff-view.ts";

const maxPatchBytes = 5 * 1024 * 1024;
const maxStatusBytes = 1024 * 1024;
const gitTimeoutMs = 10_000;
const largeFileThresholdBytes = 1024 * 1024;
const maxUntrackedPreviewBytes = 200 * 1024;
const maxUntrackedPreviewLines = 500;

export interface WorkspaceDiffSnapshot {
  files: FileDiffData[];
  truncated: boolean;
  error?: string;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

async function readLimited(stream: Readable, maximum: number): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let truncated = false;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (truncated) continue;
    const remaining = Math.max(0, maximum - bytes);
    if (value.byteLength > remaining) {
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      truncated = true;
      bytes = maximum;
      continue;
    }
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated };
}

async function git(workspaceDirectory: string, args: string[], maximum: number): Promise<CommandOutput> {
  const child = spawn("git", args, {
    cwd: workspaceDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }
  });
  const timeout = setTimeout(() => child.kill(), gitTimeoutMs);
  const exited = new Promise<number>((resolveExit) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolveExit(code);
    };
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readLimited(child.stdout, maximum),
      readLimited(child.stderr, 128 * 1024),
      exited
    ]);
    return {
      stdout: stdout.text,
      stderr: stderr.text.trim(),
      exitCode,
      truncated: stdout.truncated || stderr.truncated
    };
  } finally {
    clearTimeout(timeout);
  }
}

function cleanGitPath(path: string | undefined): string | undefined {
  if (!path || path === "/dev/null") return undefined;
  return path.replace(/^[ab]\//u, "");
}

function countChanges(hunks: FileDiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function statusFiles(value: string): Map<string, { code: string; oldPath?: string }> {
  const entries = value.split("\0");
  const files = new Map<string, { code: string; oldPath?: string }>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    if (/[RC]/u.test(code)) {
      const oldPath = entries[index + 1] || undefined;
      index += 1;
      files.set(path, { code, oldPath });
    } else {
      files.set(path, { code });
    }
  }
  return files;
}

function statusLabel(code: string, oldPath?: string): Pick<FileDiffData, "status" | "isUntracked" | "oldFilePath"> {
  if (code === "??") return { status: "untracked", isUntracked: true };
  if (code.includes("R")) return { status: "renamed", oldFilePath: oldPath };
  if (code.includes("A")) return { status: "added" };
  if (code.includes("D")) return { status: "deleted" };
  return { status: "modified" };
}

export function parseWorkspaceDiff(patchText: string, statusText: string, truncated = false): WorkspaceDiffSnapshot {
  const statuses = statusFiles(statusText);
  const files = new Map<string, FileDiffData>();
  try {
    for (const patch of parsePatch(patchText)) {
      const oldPath = cleanGitPath(patch.oldFileName);
      const newPath = cleanGitPath(patch.newFileName);
      const filePath = newPath ?? oldPath;
      if (!filePath) continue;
      const hunks: FileDiffHunk[] = patch.hunks.map((hunk) => ({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines: hunk.lines
      }));
      const changes = countChanges(hunks);
      const status = statuses.get(filePath);
      files.set(filePath, {
        filePath,
        ...changes,
        structuredPatch: hunks,
        truncated,
        ...(status ? statusLabel(status.code, status.oldPath) : {
          status: !oldPath ? "added" : !newPath ? "deleted" : "modified"
        }),
        isBinary: patch.isBinary === true
      });
    }
  } catch {
    truncated = true;
  }

  for (const [filePath, status] of statuses) {
    if (files.has(filePath)) continue;
    files.set(filePath, {
      filePath,
      additions: 0,
      deletions: 0,
      structuredPatch: [],
      truncated,
      ...statusLabel(status.code, status.oldPath),
      isBinary: false
    });
  }
  return { files: [...files.values()].sort((left, right) => left.filePath.localeCompare(right.filePath)), truncated };
}

export async function readWorkspaceDiff(workspaceDirectory: string): Promise<WorkspaceDiffSnapshot> {
  const [status, patch] = await Promise.all([
    git(workspaceDirectory, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "."], maxStatusBytes),
    git(workspaceDirectory, ["diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--", "."], maxPatchBytes)
  ]);
  if (status.exitCode !== 0) {
    return { files: [], truncated: status.truncated, error: status.stderr || "Unable to read Git status." };
  }
  const snapshot = parseWorkspaceDiff(patch.stdout, status.stdout, status.truncated || patch.truncated);
  await enrichWorkspaceFiles(snapshot, workspaceDirectory);
  if (patch.exitCode !== 0 && !snapshot.error) snapshot.error = patch.stderr || "Unable to read Git diff.";
  return snapshot;
}

export async function enrichWorkspaceFiles(
  snapshot: WorkspaceDiffSnapshot,
  workspaceDirectory: string
): Promise<void> {
  const root = resolve(workspaceDirectory);
  await Promise.all(snapshot.files.map(async (entry) => {
    const path = resolve(root, entry.filePath);
    if (path !== root && !path.startsWith(`${root}${sep}`)) return;
    const metadata = await stat(path).catch(() => undefined);
    if (!metadata?.isFile()) return;
    entry.isLargeFile = metadata.size > largeFileThresholdBytes;
    if (!entry.isUntracked || entry.isLargeFile) return;
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.includes(0)) {
      entry.isBinary = true;
      return;
    }
    if (bytes.byteLength > maxUntrackedPreviewBytes) {
      entry.isLargeFile = true;
      return;
    }
    const sourceLines = new TextDecoder().decode(bytes).replace(/\r/gu, "").split("\n");
    if (sourceLines.at(-1) === "") sourceLines.pop();
    const visibleLines = sourceLines.slice(0, maxUntrackedPreviewLines);
    entry.additions = sourceLines.length;
    entry.structuredPatch = visibleLines.length > 0 ? [{
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: sourceLines.length,
      lines: visibleLines.map((line) => `+${line}`)
    }] : [];
    if (visibleLines.length < sourceLines.length) entry.truncated = true;
  }));
}
