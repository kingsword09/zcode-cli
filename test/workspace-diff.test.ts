import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enrichWorkspaceFiles,
  parseWorkspaceDiff
} from "../packages/zcode-tui/src/workspace-diff.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace diff reader", () => {
  test("combines Git patches with tracked and untracked status", () => {
    const patch = [
      "diff --git a/src/value.ts b/src/value.ts",
      "index 1111111..2222222 100644",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      ""
    ].join("\n");
    const snapshot = parseWorkspaceDiff(patch, " M src/value.ts\0?? notes.txt\0");

    expect(snapshot.files).toHaveLength(2);
    expect(snapshot.files[1]).toMatchObject({
      filePath: "src/value.ts",
      additions: 1,
      deletions: 1,
      status: "modified"
    });
    expect(snapshot.files[0]).toMatchObject({
      filePath: "notes.txt",
      status: "untracked",
      isUntracked: true
    });
  });

  test("keeps rename metadata and global truncation", () => {
    const snapshot = parseWorkspaceDiff("", "R  new.ts\0old.ts\0", true);
    expect(snapshot.files[0]).toMatchObject({
      filePath: "new.ts",
      oldFilePath: "old.ts",
      status: "renamed",
      truncated: true
    });
  });

  test("marks only the corresponding binary patch as binary", () => {
    const snapshot = parseWorkspaceDiff([
      "diff --git a/image.png b/image.png",
      "index 1111111..2222222 100644",
      "Binary files a/image.png and b/image.png differ",
      ""
    ].join("\n"), " M image.png\0");
    expect(snapshot.files[0]).toMatchObject({ filePath: "image.png", isBinary: true });
  });

  test("previews small text files and classifies untracked binary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-diff-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "notes.txt"), "first\nsecond\n");
    await writeFile(join(directory, "image.bin"), new Uint8Array([1, 0, 2]));
    const snapshot = parseWorkspaceDiff("", "?? notes.txt\0?? image.bin\0");
    await enrichWorkspaceFiles(snapshot, directory);

    expect(snapshot.files.find((file) => file.filePath === "notes.txt")).toMatchObject({
      additions: 2,
      isBinary: false,
      structuredPatch: [{ lines: ["+first", "+second"] }]
    });
    expect(snapshot.files.find((file) => file.filePath === "image.bin")?.isBinary).toBe(true);
  });
});
