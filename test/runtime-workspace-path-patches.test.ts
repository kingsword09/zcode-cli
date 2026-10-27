import { expect, test } from "bun:test";
import {
  hasRuntimeRecursiveWorkspacePaths as has,
  patchRuntimeRecursiveWorkspacePaths as patch
} from "../scripts/runtime-workspace-path-patches.ts";
import { applyRuntimePatchPlan, runtimePatchPlan } from "../scripts/sync-runtime.ts";

const fixture = 'function provider(e){let fs=e.fileSystemPort??defaultFS(),root=(0,path.resolve)(e.workspaceDirectory);'
  + 'return async request=>{let entries=(await fs.listDirectory({path:root},{signal:request.abortSignal})).entries;'
  + 'return{items:entries.filter(entry=>!excluded.has(entry.name)),truncated:false}}}'
  + 'label(provider,"createWorkspacePathSuggestionProvider");';

test("wraps the native callback idempotently and keeps its filesystem and exclusions", () => {
  const patched = patch(fixture);
  expect(has(fixture)).toBe(false);
  expect(has(patched)).toBe(true);
  expect(patch(patched)).toBe(patched);
  expect(patched).toContain("{workspaceDirectory:root,fileSystemPort:fs,excludedDirectories:excluded}");
  expect(patched).toContain("entries.filter(entry=>!excluded.has(entry.name))");
  const renamed = fixture.replaceAll("provider", "$factory").replaceAll("root", "$root").replaceAll("fs", "$fs");
  expect(has(patch(renamed))).toBe(true);
});

test("rejects changed, missing and ambiguous native anchors and incomplete wrappers", () => {
  for (const source of [
    "const runtime = {};",
    `${fixture}label(other,"createWorkspacePathSuggestionProvider");`,
    fixture.replace("function provider(e)", "function provider(e, other)"),
    fixture.replace("e.fileSystemPort", "e.otherPort"),
    fixture.replace(".listDirectory(", ".searchFiles("),
    fixture.replace("excluded.has(entry.name)", "false"),
    patch(fixture).replace("excludedDirectories:excluded", "excludedDirectories:other"),
    patch(fixture).replace("withRecursiveWorkspacePathSuggestions", "wrongWrapper")
  ]) {
    expect(has(source)).toBe(false);
    expect(() => patch(source)).toThrow("incompatible with recursive workspace paths");
  }
});

test("registers recursion as a required, verified runtime patch", () => {
  const entry = runtimePatchPlan.find(item => item.id === "recursive-workspace-paths");
  expect(entry?.requirement).toBe("required");
  const first = applyRuntimePatchPlan(fixture, [entry!]);
  expect(first.reports[0]?.status).toBe("applied");
  expect(applyRuntimePatchPlan(first.runtime, [entry!]).reports[0]?.status).toBe("already_present");
  expect(() => applyRuntimePatchPlan("incompatible runtime", [entry!]))
    .toThrow("Required runtime patch recursive-workspace-paths failed");
});
