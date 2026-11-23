import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "acorn";
import { patchRuntimeBigmodelSessionReuse, patchRuntimePromptModel } from "../../scripts/sync-runtime.ts";

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
