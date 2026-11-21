import { expect, test } from "bun:test";
import { explicitModelRequest, isModelDefaultRequest } from "../packages/zcode-tui/src/selectors.ts";

test("isModelDefaultRequest matches only the exact /model default form", () => {
  expect(isModelDefaultRequest("/model default")).toBe(true);
  expect(isModelDefaultRequest("  /model default  ")).toBe(true);
  expect(isModelDefaultRequest("/MODEL DEFAULT")).toBe(true);
  expect(isModelDefaultRequest("/model default ")).toBe(true);
  expect(isModelDefaultRequest("/model")).toBe(false);
  expect(isModelDefaultRequest("/model list")).toBe(false);
  expect(isModelDefaultRequest("/model account:zai-start-plan/GLM-5.3-Flash")).toBe(false);
  expect(isModelDefaultRequest("/model defaults")).toBe(false);
  expect(isModelDefaultRequest("")).toBe(false);
});

test("explicitModelRequest still treats other /model arguments as transient switches", () => {
  expect(explicitModelRequest("/model default")).toBeUndefined();
  expect(explicitModelRequest("/model account:zai-start-plan/GLM-5.3-Flash")).toBe("account:zai-start-plan/GLM-5.3-Flash");
  expect(explicitModelRequest("/model main")).toBe("main");
});
