import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FullscreenHeader, SessionWelcome } from "../packages/zcode-tui/src/fullscreen-header.ts";
import { runtimePollStateChanged } from "../packages/zcode-tui/src/runtime-poll.ts";
import { normalizeRuntimeProjection } from "../packages/zcode-tui/src/runtime-projection.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import { readTuiRuntimeProjection, type RuntimeTuiApp } from "../src/runtime-tui-bridge.ts";

const execFileAsync = promisify(execFile);
let directory: string;

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "zcode-workspace-state-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function appAt(workingDirectory?: string): RuntimeTuiApp {
  return {
    readExecutionState: () => ({ mode: "build" }),
    runtime: {
      workingDirectory,
      getProjection: () => ({ sessionId: "sess_workspace" })
    }
  };
}

test("workspace snapshots use the runtime directory after preparing resume", async () => {
  const resumedDirectory = join(directory, "resumed-project");
  await mkdir(resumedDirectory);
  await execFileAsync("git", ["init", "-q", "-b", "resumed-branch"], { cwd: resumedDirectory });
  const app = appAt(directory);
  app.readExecutionState = () => {
    app.runtime!.workingDirectory = resumedDirectory;
    return { mode: "build" };
  };
  expect((await readTuiRuntimeProjection(app, {}))?.workspace).toEqual({
    directory: resumedDirectory, branch: "resumed-branch"
  });
});

test("changing directories refreshes the branch and clears it outside a repository", async () => {
  const project = join(directory, "project");
  const plain = join(directory, "plain");
  await mkdir(project);
  await mkdir(plain);
  await execFileAsync("git", ["init", "-q", "-b", "project-branch"], { cwd: project });
  const app = appAt(project);
  expect((await readTuiRuntimeProjection(app, {}))?.workspace).toEqual({ directory: project, branch: "project-branch" });
  app.runtime!.workingDirectory = plain;
  expect((await readTuiRuntimeProjection(app, {}))?.workspace).toEqual({ directory: plain });
  app.runtime!.workingDirectory = project;
  expect((await readTuiRuntimeProjection(app, {}))?.workspace).toEqual({ directory: project, branch: "project-branch" });
});

test("unavailable repositories retain their directory without breaking projection reads", async () => {
  const missing = join(directory, "missing");
  expect((await readTuiRuntimeProjection(appAt(missing), {}))?.workspace).toEqual({ directory: missing });
  expect((await readTuiRuntimeProjection(appAt(), {}))?.workspace).toBeUndefined();
});

test("workspace normalization preserves filesystem paths and ignores malformed snapshots", () => {
  const workspace = { directory: join(directory, "project "), branch: " branch " };
  expect(normalizeRuntimeProjection({ workspace })?.workspace).toEqual({ directory: workspace.directory, branch: "branch" });
  for (const invalid of [undefined, null, {}, { directory: "" }, { directory: 12 }]) {
    expect(normalizeRuntimeProjection({ workspace: invalid })?.workspace).toBeUndefined();
  }
});

test("header and regular welcome follow workspace changes and sanitize terminal controls", () => {
  const theme = createTheme(false);
  const header = new FullscreenHeader(theme, {
    workspace: "/home/test/launch", branch: "launch-branch", runtimeVersion: "test", homeDirectory: "/home/test"
  });
  const welcome = new SessionWelcome(theme, width => header.location(width), width => header.identity(width));
  header.setWorkspace("/home/test/resumed\x1b]0;injected\x07", "resumed-branch\x1b[31m");
  expect(header.location(100)).toContain("~/resumed");
  expect(header.location(100)).toContain("resumed-branch");
  expect(welcome.render(100).join("\n")).toContain("~/resumed");
  expect(welcome.render(100).join("\n")).not.toMatch(/launch|injected|\x1b/u);
  header.setWorkspace("/home/test/plain");
  expect(header.location(100)).toBe("~/plain");
  expect(welcome.render(100).join("\n")).not.toContain("resumed-branch");
});

test("workspace-only projection changes trigger a runtime UI refresh", () => {
  const current = { projection: normalizeRuntimeProjection({ sessionId: "same", workspace: { directory, branch: "old" } }), todos: [], todoGroups: [] };
  const next = { ...current, projection: normalizeRuntimeProjection({ sessionId: "same", workspace: { directory, branch: "new" } }) };
  expect(runtimePollStateChanged(current, next)).toBe(true);
});
