import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBackgroundTaskOutput } from "../packages/zcode-tui/src/background-task-output.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("background task output", () => {
  test("reads a saved task result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-task-output-"));
    directories.push(directory);
    const path = join(directory, "output.txt");
    await writeFile(path, "  completed result\n");

    expect(readBackgroundTaskOutput(path)).toEqual({
      text: "completed result",
      truncated: false
    });
  });

  test("bounds large results and ignores unavailable files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-task-output-"));
    directories.push(directory);
    const path = join(directory, "output.txt");
    await writeFile(path, "older output\nlatest result");

    expect(readBackgroundTaskOutput(path, 13)).toEqual({
      text: "latest result",
      truncated: true
    });
    expect(readBackgroundTaskOutput(join(directory, "missing.txt"))).toBeUndefined();
  });
});
