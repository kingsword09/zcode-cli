import { parseArgs } from "node:util";
import type { RuntimeCliOptionType } from "./runtime-capabilities.ts";

export interface PromptOverrides {
  args: string[];
  effort?: string;
  model?: string;
  headless: boolean;
}

function removalIndexes(token: { index: number; inlineValue?: boolean }): number[] {
  return token.inlineValue ? [token.index] : [token.index, token.index + 1];
}

export function extractPromptOverrides(
  args: string[], optionTypes: Readonly<Record<string, RuntimeCliOptionType>>, allowBareModel = false
): PromptOverrides {
  const options = Object.fromEntries(Object.entries(optionTypes).map(([name, type]) => [name, { type }]));
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    tokens: true,
    options: {
      ...options,
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      prompt: { type: "string", short: "p" },
      model: { type: "string" },
      effort: { type: "string" }
    }
  });
  const modelTokens = parsed.tokens.filter(token => token.kind === "option" && token.name === "model");
  const effortTokens = parsed.tokens.filter(token => token.kind === "option" && token.name === "effort");
  const headless = typeof parsed.values.prompt === "string" && !parsed.values.help && !parsed.values.version;
  if (modelTokens.length === 0 && effortTokens.length === 0) return { args, headless: Boolean(headless) };
  if (modelTokens.length !== 0 && modelTokens.length !== 1) throw new Error("Specify --model only once.");
  if (effortTokens.length !== 0 && effortTokens.length !== 1) throw new Error("Specify --effort only once.");
  if (typeof parsed.values.prompt !== "string") {
    throw new Error(`${modelTokens.length ? "--model" : "--effort"} requires --prompt or -p.`);
  }

  const removed = new Set<number>();
  let model: string | undefined;
  let effort: string | undefined;
  if (modelTokens.length === 1) {
    if (typeof parsed.values.model !== "string") throw new Error("--model must be a provider/model ID.");
    model = parsed.values.model.trim();
    if (allowBareModel ? !model || /\s/u.test(model) || model.startsWith("-") : !/^[^/\s]+\/\S+$/u.test(model)) {
      throw new Error(allowBareModel ? "--model must be a model ID." : "--model must be a provider/model ID.");
    }
    for (const index of removalIndexes(modelTokens[0]!)) removed.add(index);
  }
  if (effortTokens.length === 1) {
    if (typeof parsed.values.effort !== "string") throw new Error("--effort requires a value.");
    effort = parsed.values.effort.trim();
    if (!effort || effort.startsWith("-") || /\s/u.test(effort)) {
      throw new Error("--effort requires a single effort level.");
    }
    for (const index of removalIndexes(effortTokens[0]!)) removed.add(index);
  }
  return { args: args.filter((_, index) => !removed.has(index)), model, effort, headless: Boolean(headless) };
}
