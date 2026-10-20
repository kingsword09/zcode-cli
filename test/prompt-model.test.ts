import { expect, test } from "bun:test";
import { extractPromptModel } from "../src/prompt-model.ts";
import { patchRuntimePromptModel } from "../scripts/sync-runtime.ts";

const model = "account:zai-start-plan/GLM-5.3-Flash";
const options = { prompt: "string", resume: "string" } as const;

test("extracts a per-prompt model while preserving prompt text and resume arguments", () => {
  expect(extractPromptModel(["--model", model, "-p", "ok", "--resume", "session"], options))
    .toEqual({ args: ["-p", "ok", "--resume", "session"], model });
  expect(extractPromptModel([`--model=${model}`, "--prompt=ok"], options))
    .toEqual({ args: ["--prompt=ok"], model });
  expect(extractPromptModel(["--prompt", "--model"], options))
    .toEqual({ args: ["--prompt", "--model"] });
  expect(() => extractPromptModel(["--model", "glm", "-p", "ok"], options)).toThrow(/provider\/model/);
  expect(() => extractPromptModel(["--model", model], options)).toThrow(/requires --prompt/);
  expect(() => extractPromptModel(["--model", model, "--model", model, "-p", "ok"], options)).toThrow(/only once/);
});

test("switches the cli-default selection before submitting a prompt and propagates invalid models", async () => {
  const source = [
    'async function run(app,options){let trace;if(trace=app.traceId,options.memoryBench)throw Error("unused");return app.submitPrompt("ok")}',
    'function setModel(e,f,x){return e.cliDefaultSelection&&!f?.transient?e.cliDefaultSelection.set(x):e.runtime.setSessionModelSelection(x),f?.transient||void 0,x}'
  ].join("");
  const patched = patchRuntimePromptModel(source);
  expect(patchRuntimePromptModel(patched)).toBe(patched);
  expect(() => patchRuntimePromptModel("unsupported")).toThrow(/incompatible/);
  expect(() => patchRuntimePromptModel('async function run(app,options){let trace;if(trace=app.traceId,options.memoryBench)throw Error("unused");return app.submitPrompt("ok")}'))
    .toThrow(/cli-default selection anchor missing/);
  const load = (env: Record<string, string>) => new Function("process", `${patched};return {run,setModel}`)({ env });
  const events: unknown[] = [];
  const app = {
    traceId: "fixture", setModel: async (...args: unknown[]) => { events.push(args); },
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
  const context = {
    cliDefaultSelection: { set: (value: unknown) => { cliSelection = value; } },
    runtime: { setSessionModelSelection: (value: unknown) => { runtimeSelection = value; } }
  };
  const selection = { providerId: "p", modelId: "m" };
  const loaded = load({});
  expect(loaded.setModel(context, { transient: true, cliDefault: true }, selection)).toBe(selection);
  expect(cliSelection).toBe(selection);
  expect(runtimeSelection).toBeUndefined();
  loaded.setModel(context, { transient: true }, selection);
  expect(runtimeSelection).toBe(selection);
  loaded.setModel(context, undefined, { providerId: "q", modelId: "n" });
  expect(cliSelection).toEqual({ providerId: "q", modelId: "n" });
  runtimeSelection = undefined;
  loaded.setModel({ runtime: context.runtime }, { transient: true, cliDefault: true }, selection);
  expect(runtimeSelection).toBe(selection);
});
