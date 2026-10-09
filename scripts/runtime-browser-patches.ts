import { parseExpressionAt } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";
const bridge = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';

function incompatible(): never {
  throw new Error("ZCode runtime is incompatible with browser URL opening (missing, ambiguous or changed command builder).");
}

function inspect(runtime: string) {
  const labels = [...runtime.matchAll(new RegExp(`${identifier}\\((${identifier}),"browserOpenCommand"\\)`, "gu"))];
  if (labels.length !== 1) incompatible();
  const name = labels[0]![1]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const functions = [...runtime.matchAll(new RegExp(`function ${name}\\(`, "gu"))];
  if (functions.length !== 1) incompatible();
  const fn = parseExpressionAt(runtime, functions[0]!.index!, { ecmaVersion: "latest" });
  if (fn.type !== "FunctionExpression" || fn.params.length !== 2
    || fn.params[0]?.type !== "Identifier" || fn.params[1]?.type !== "Identifier") incompatible();
  const platform = fn.params[0].name, url = fn.params[1].name;
  const original = `return ${platform}==="darwin"?{executable:"open",args:[${url}]}:${platform}==="win32"?{executable:"cmd.exe",args:["/c","start","",${url}]}:{executable:"xdg-open",args:[${url}]}`;
  const replacement = `return ${bridge}.browserOpenCommand(${platform},${url})`;
  const body = runtime.slice(fn.body.start + 1, fn.body.end - 1);
  if (body !== original && body !== replacement) incompatible();
  return { start: fn.body.start + 1, end: fn.body.end - 1, replacement, patched: body === replacement };
}

export function hasRuntimeBrowserUrlOpening(runtime: string): boolean {
  try { return inspect(runtime).patched; } catch { return false; }
}

export function patchRuntimeBrowserUrlOpening(runtime: string): string {
  const { start, end, replacement, patched } = inspect(runtime);
  return patched ? runtime : runtime.slice(0, start) + replacement + runtime.slice(end);
}
