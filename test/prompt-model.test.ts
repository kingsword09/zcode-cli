import { expect, test } from "bun:test";
import { extractPromptOverrides } from "../src/prompt-model.ts";
import { patchRuntimePromptModel } from "../scripts/sync-runtime.ts";

const model = "account:zai-start-plan/GLM-5.3-Flash";
const options = { prompt: "string", resume: "string" } as const;

test("extracts per-prompt model and effort while preserving prompt text and resume arguments", () => {
  expect(extractPromptOverrides(["--model", model, "--effort", "high", "-p", "ok", "--resume", "session"], options))
    .toEqual({ args: ["-p", "ok", "--resume", "session"], model, effort: "high" });
  expect(extractPromptOverrides([`--model=${model}`, "--effort=high", "--prompt=ok"], options))
    .toEqual({ args: ["--prompt=ok"], model, effort: "high" });
  expect(extractPromptOverrides(["--model", model, "-p", "ok"], options))
    .toEqual({ args: ["-p", "ok"], model });
  expect(extractPromptOverrides(["--effort", "high", "-p", "ok"], options))
    .toEqual({ args: ["-p", "ok"], effort: "high" });
  expect(extractPromptOverrides(["--prompt", "--model"], options))
    .toEqual({ args: ["--prompt", "--model"] });
  expect(extractPromptOverrides(["--prompt", "--effort"], options))
    .toEqual({ args: ["--prompt", "--effort"] });
  expect(() => extractPromptOverrides(["--model", "glm", "-p", "ok"], options)).toThrow(/provider\/model/);
  expect(() => extractPromptOverrides(["--model", model], options)).toThrow(/requires --prompt/);
  expect(() => extractPromptOverrides(["--effort", "high"], options)).toThrow(/requires --prompt/);
  expect(() => extractPromptOverrides(["--model", model, "--model", model, "-p", "ok"], options)).toThrow(/only once/);
  expect(() => extractPromptOverrides(["--effort", "high", "--effort", "low", "-p", "ok"], options)).toThrow(/only once/);
  expect(() => extractPromptOverrides(["--effort", "", "-p", "ok"], options)).toThrow(/single effort level/);
  expect(() => extractPromptOverrides(["--model", model, "--prompt", "ok", "--effort"], options)).toThrow(/requires a value/);
  expect(() => extractPromptOverrides(["--effort", "--model", model, "-p", "ok"], options)).toThrow(/single effort level/);
});

const source = [
  'async function run(app,options){let trace;if(trace=app.traceId,options.memoryBench)throw Error("unused");',
  'return app.submitPrompt("ok")}',
  'async function setModel(e,f,x){return e.cliDefaultSelection&&!f?.transient?e.cliDefaultSelection.set(x):e.runtime.setSessionModelSelection(x),f?.transient||void 0,x}'
].join("");

function load(env: Record<string, string>) {
  return new Function("process", `${patchRuntimePromptModel(source)};return {run,setModel}`)({ env }) as {
    run: (app: unknown, options: Record<string, unknown>) => Promise<string>;
    setModel: (context: unknown, options: unknown, selection: unknown) => Promise<unknown>;
  };
}

function reasoningModel(providerId = "p", modelId = "m", levels = ["low", "high", "max"]) {
  const reasoning = { levels: levels.map(value => ({ value, label: value })) };
  return { ref: { providerId, modelId }, reasoning };
}

test("switches the cli-default selection before submitting a prompt and propagates invalid models", async () => {
  const events: unknown[] = [];
  const app = {
    traceId: "fixture",
    setModel: async (...args: unknown[]) => { events.push(args); },
    submitPrompt: async () => { events.push("prompt"); return "ok"; }
  };
  expect(await load({ ZCODE_CLI_PROMPT_MODEL: model }).run(app, {})).toBe("ok");
  expect(events).toEqual([[model, { transient: true, cliDefault: true }], "prompt"]);
  events.length = 0;
  await load({}).run(app, {});
  expect(events).toEqual(["prompt"]);
  events.length = 0;
  await expect(load({ ZCODE_CLI_PROMPT_MODEL: model }).run({ ...app,
    setModel: async () => { throw new Error("Unknown model"); }
  }, {})).rejects.toThrow("Unknown model");
  expect(events).toEqual([]);

  // A prompt override updates CliDefaultSelection without persisting a session switch.
  let cliSelection: unknown;
  let runtimeSelection: unknown;
  let resumes = 0;
  const context = {
    prepareResume: async () => { resumes++; },
    cliDefaultSelection: { set: (value: unknown) => { cliSelection = value; } },
    runtime: { setSessionModelSelection: (value: unknown) => { runtimeSelection = value; } }
  };
  const selection = { providerId: "p", modelId: "m" };
  const loaded = load({});
  expect(await loaded.setModel(context, { transient: true, cliDefault: true }, selection)).toBe(selection);
  expect(cliSelection).toBe(selection);
  expect(runtimeSelection).toBeUndefined();
  expect(resumes).toBe(1);
  await loaded.setModel(context, { transient: true }, selection);
  expect(runtimeSelection).toBe(selection);
  await loaded.setModel(context, undefined, { providerId: "q", modelId: "n" });
  expect(cliSelection).toEqual({ providerId: "q", modelId: "n" });
  runtimeSelection = undefined;
  await loaded.setModel({ runtime: context.runtime }, { transient: true, cliDefault: true }, selection);
  expect(runtimeSelection).toBe(selection);
  expect(resumes).toBe(1);
});

test("applies model and effort in one transient selection", async () => {
  const events: unknown[] = [];
  const app = {
    traceId: "fixture",
    getModelOption: (selection: unknown) => { events.push(["getModelOption", selection]); return reasoningModel("account:zai-start-plan", "GLM-5.3-Flash", ["low", "high", "max"]); },
    setModel: async (...args: unknown[]) => { events.push(["setModel", ...args]); },
    submitPrompt: async () => { events.push("prompt"); return "ok"; }
  };
  expect(await load({ ZCODE_CLI_PROMPT_MODEL: model, ZCODE_CLI_PROMPT_EFFORT: "high" }).run(app, {})).toBe("ok");
  expect(events).toEqual([
    ["getModelOption", { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash" }],
    ["setModel", {
      providerId: "account:zai-start-plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "high" }
    }, { transient: true, cliDefault: true }],
    "prompt"
  ]);
});

test("applies effort to the resumed current model without a model override", async () => {
  const events: unknown[] = [];
  const current = reasoningModel("saved-provider", "saved-model", ["disabled", "low", "high"]);
  const app = {
    traceId: "fixture",
    readExecutionState: async () => { events.push("resume"); return { mode: "build", planEnabled: false }; },
    getCurrentModelOption: () => { events.push("getCurrentModelOption"); return current; },
    getModelOption: (selection: unknown) => { events.push(["getModelOption", selection]); return current; },
    setModel: async (...args: unknown[]) => { events.push(["setModel", ...args]); },
    submitPrompt: async () => { events.push("prompt"); return "ok"; }
  };
  expect(await load({ ZCODE_CLI_PROMPT_EFFORT: "HIGH" }).run(app, {})).toBe("ok");
  expect(events).toEqual([
    "resume",
    "getCurrentModelOption",
    ["getModelOption", { providerId: "saved-provider", modelId: "saved-model" }],
    ["setModel", {
      providerId: "saved-provider",
      modelId: "saved-model",
      options: { reasoningLevel: "high" }
    }, { transient: true, cliDefault: true }],
    "prompt"
  ]);
});

test("rejects an unsupported effort before sending the prompt", async () => {
  const events: unknown[] = [];
  const app = {
    traceId: "fixture",
    getModelOption: () => reasoningModel("p", "m", ["low", "high"]),
    setModel: async (...args: unknown[]) => { events.push(["setModel", ...args]); },
    submitPrompt: async () => { events.push("prompt"); return "ok"; }
  };
  await expect(load({ ZCODE_CLI_PROMPT_MODEL: model, ZCODE_CLI_PROMPT_EFFORT: "medium" }).run(app, {}))
    .rejects.toThrow(/Unsupported reasoning effort: medium\. Available: low, high\./);
  expect(events).toEqual([]);
});

test("rejects effort for a model without reasoning levels", async () => {
  const app = {
    traceId: "fixture",
    getModelOption: () => ({ ref: { providerId: "p", modelId: "m" }, reasoning: { levels: [] } }),
    setModel: async () => { throw new Error("should not be called"); },
    submitPrompt: async () => { throw new Error("should not be called"); }
  };
  await expect(load({ ZCODE_CLI_PROMPT_MODEL: model, ZCODE_CLI_PROMPT_EFFORT: "high" }).run(app, {}))
    .rejects.toThrow(/does not support reasoning effort/);
});

test("rejects effort-only runs without a current model", async () => {
  const app = {
    traceId: "fixture",
    readExecutionState: async () => ({ mode: "build", planEnabled: false }),
    getCurrentModelOption: () => undefined,
    setModel: async () => { throw new Error("should not be called"); },
    submitPrompt: async () => { throw new Error("should not be called"); }
  };
  await expect(load({ ZCODE_CLI_PROMPT_EFFORT: "high" }).run(app, {}))
    .rejects.toThrow(/without a current model/);
});

test("auto leaves the current effort unchanged", async () => {
  const events: unknown[] = [];
  const app = {
    traceId: "fixture",
    setModel: async (...args: unknown[]) => { events.push(["setModel", ...args]); },
    submitPrompt: async () => { events.push("prompt"); return "ok"; }
  };
  expect(await load({ ZCODE_CLI_PROMPT_EFFORT: "auto" }).run(app, {})).toBe("ok");
  expect(events).toEqual(["prompt"]);
});

test("upgrades a runtime that only has the earlier model override", () => {
  const legacy = source.replace(
    'return app.submitPrompt("ok")}',
    'let $zCliDefaultPromptModel=process.env.ZCODE_CLI_PROMPT_MODEL;if($zCliDefaultPromptModel)await app.setModel($zCliDefaultPromptModel,{transient:true,cliDefault:true});return app.submitPrompt("ok")}'
  );
  const patched = patchRuntimePromptModel(legacy);
  expect(patched).toContain("$zCliDefaultPromptEffort");
  expect(patched).toContain("ZCODE_CLI_PROMPT_EFFORT");
  expect(patched).not.toContain("if($zCliDefaultPromptModel)await app.setModel($zCliDefaultPromptModel");
  expect(patchRuntimePromptModel(patched)).toBe(patched);
});

test.each([true, false])("applies a prompt override after lazy resume restores the shared CLI selection (saved valid: %p)", async valid => {
  const loaded = new Function("process", `${patchRuntimePromptModel(source)};return {run,setModel}`)({
    env: { ZCODE_CLI_PROMPT_MODEL: model }
  });
  const events: unknown[] = [];
  const saved = { providerId: "saved", modelId: "model" };
  let selection: unknown;
  let resumed = false;
  const context = {
    cliDefaultSelection: { set: (value: unknown) => { selection = value; } },
    runtime: { setSessionModelSelection: (value: unknown) => { selection = value; } },
    async prepareResume() {
      if (resumed) return;
      events.push("resume");
      context.cliDefaultSelection.set(valid ? saved : undefined);
      resumed = true;
    }
  };
  const app = {
    traceId: "fixture",
    setModel: (value: unknown, options: unknown) => loaded.setModel(context, options, value),
    async submitPrompt() {
      await context.prepareResume();
      events.push(selection);
      if (!selection) throw new Error("Saved model is unavailable");
      return selection;
    }
  };
  expect(await loaded.run(app, {})).toBe(model);
  expect(events).toEqual(["resume", model]);
});
