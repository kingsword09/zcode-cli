import { describe, expect, test } from "bun:test";

import { extractPromptOverrides } from "../src/prompt-model.ts";

describe("CLI model overrides", () => {
  test("extracts model and effort overrides for an interactive session", () => {
    expect(extractPromptOverrides([
      "--model", "account:zai-plan/GLM-5.3-Flash", "--effort=high"
    ], {})).toEqual({
      args: [],
      model: "account:zai-plan/GLM-5.3-Flash",
      effort: "high"
    });
  });

  test("extracts overrides when resuming without changing resume arguments", () => {
    expect(extractPromptOverrides([
      "--resume", "session-123", "--model=provider/model", "--effort", "auto"
    ], {})).toEqual({
      args: ["--resume", "session-123"],
      model: "provider/model",
      effort: "auto"
    });
  });

  test("keeps headless prompt arguments while extracting overrides", () => {
    expect(extractPromptOverrides([
      "-p", "hello", "--model", "provider/model"
    ], {})).toEqual({
      args: ["-p", "hello"],
      model: "provider/model",
      effort: undefined
    });
  });

  test("validates override syntax and rejects duplicate options", () => {
    expect(() => extractPromptOverrides(["--model", "invalid"], {}))
      .toThrow("--model must be a provider/model ID.");
    expect(() => extractPromptOverrides(["--model=a/b", "--model=c/d"], {}))
      .toThrow("Specify --model only once.");
    expect(() => extractPromptOverrides(["--effort", "very high"], {}))
      .toThrow("--effort requires a single effort level.");
  });
});
