import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "acorn";
import {
  applyRuntimePatchPlan,
  hasRuntimeHttpNoContentGuard,
  hasRuntimeNativePollingOAuth,
  hasRuntimeTrackedDetachedAgentLifecycle,
  patchRuntimeBigmodelSessionReuse,
  patchRuntimePromptModel,
  runtimePatchPlan
} from "../../scripts/sync-runtime.ts";

test("4.0 native runtime features are verified without applying legacy compatibility rewrites", async () => {
  const runtime = await readFile(new URL("../../vendor/zcode.cjs", import.meta.url), "utf8");
  const nativePatches = new Map(runtimePatchPlan.map(patch => [patch.id, patch]));
  expect(nativePatches.has("official-mcp-availability")).toBe(false);
  expect(runtime).toContain("official MCP trusted origin registry is not available in this runtime");

  for (const [id, check] of [
    ["detached-agent-lifecycle", hasRuntimeTrackedDetachedAgentLifecycle],
    ["http-no-content", hasRuntimeHttpNoContentGuard],
    ["native-oauth-polling", hasRuntimeNativePollingOAuth]
  ] as const) {
    const patch = nativePatches.get(id);
    expect(patch, `missing native runtime check ${id}`).toBeDefined();
    expect(patch!.apply(runtime)).toBe(runtime);
    expect(patch!.verify?.(runtime)).toBe(true);
  }

  for (const id of ["http-no-content", "native-oauth-polling"]) {
    const patch = nativePatches.get(id)!;
    expect(() => applyRuntimePatchPlan("", [patch])).toThrow(`Required runtime patch ${id} failed`);
  }
});

test("4.0 TUI prompt overrides apply before the current app wrapper returns", async () => {
  const runtime = await readFile(new URL("../../vendor/zcode.cjs", import.meta.url), "utf8");
  const patched = patchRuntimePromptModel(runtime);
  expect(patched).toContain("$zTuiCliDefaultPromptModel");
  expect(patchRuntimePromptModel(patched)).toBe(patched);
  expect(() => parse(patched, { ecmaVersion: "latest", allowReturnOutsideFunction: true })).not.toThrow();
  const override = patched.indexOf("$zTuiCliDefaultPromptModel");
  expect(patched.indexOf('},"createApp")', override)).toBeGreaterThan(override);
});

test("4.0 BigModel session reuse holds a credential recovery guard through config persistence", async () => {
  const runtime = await readFile(new URL("../../vendor/zcode.cjs", import.meta.url), "utf8");
  const patched = patchRuntimeBigmodelSessionReuse(runtime);
  expect(patched).toContain("ZCODE_CLI_BIGMODEL_REUSE_SESSION");
  expect(patched).toContain("captureRecoveryGuard()");
  expect(patched).toContain("loadOAuthSessionSnapshot()");
  expect(patched).toContain("$bGuard.run(()=>dDi({");
  expect(patchRuntimeBigmodelSessionReuse(patched)).toBe(patched);
  expect(() => parse(patched, { ecmaVersion: "latest", allowReturnOutsideFunction: true })).not.toThrow();
});
