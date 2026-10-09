import { parseExpressionAt } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";
const bridge = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';

function incompatible(): never {
  throw new Error("ZCode runtime is incompatible with browser URL opening (missing, ambiguous or changed command builder or process launcher).");
}

function namedFunction(runtime: string, label: string) {
  const labels = [...runtime.matchAll(new RegExp(`${identifier}\\((${identifier}),"${label}"\\)`, "gu"))];
  if (labels.length !== 1) incompatible();
  const name = labels[0]![1]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const functions = [...runtime.matchAll(new RegExp(`(?:async )?function ${name}\\(`, "gu"))];
  if (functions.length !== 1) incompatible();
  const fn = parseExpressionAt(runtime, functions[0]!.index!, { ecmaVersion: "latest" });
  if (fn.type !== "FunctionExpression") incompatible();
  return fn;
}

function inspect(runtime: string) {
  const fn = namedFunction(runtime, "browserOpenCommand");
  if (fn.params.length !== 2
    || fn.params[0]?.type !== "Identifier" || fn.params[1]?.type !== "Identifier") incompatible();
  const platform = fn.params[0].name, url = fn.params[1].name;
  const original = `return ${platform}==="darwin"?{executable:"open",args:[${url}]}:${platform}==="win32"?{executable:"cmd.exe",args:["/c","start","",${url}]}:{executable:"xdg-open",args:[${url}]}`;
  const replacement = `return ${bridge}.browserOpenCommand(${platform},${url})`;
  const body = runtime.slice(fn.body.start + 1, fn.body.end - 1);
  if (body !== original && body !== replacement) incompatible();
  const commandEdit = { start: fn.body.start + 1, end: fn.body.end - 1, replacement, patched: body === replacement };

  const opener = namedFunction(runtime, "openUrlInBrowser");
  const options = opener.params[1];
  if (options?.type !== "AssignmentPattern" || options.left.type !== "Identifier") incompatible();
  const optionsName = options.left.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const openerBody = runtime.slice(opener.body.start + 1, opener.body.end - 1);
  const platforms = [...openerBody.matchAll(new RegExp(`(${identifier})=${optionsName}\\.platform\\?\\?process\\.platform`, "gu"))];
  if (platforms.length !== 1) incompatible();
  const detached = `${platforms[0]![1]}!=="win32"`;
  const spawns = [...openerBody.matchAll(new RegExp(
    `${identifier}\\((${identifier})\\.executable,\\1\\.args,\\{detached:([^,]+),stdio:"ignore",windowsHide:!0\\}\\)`, "gu"
  ))];
  if (spawns.length !== 1) incompatible();
  const spawn = spawns[0]!;
  if (spawn[2] !== "!0" && spawn[2] !== detached) incompatible();
  const start = opener.body.start + 1 + spawn.index! + spawn[0].indexOf("detached:") + "detached:".length;
  // Detached PowerShell can exit with code 0 before executing its encoded
  // command on Windows. Keep its console context; windowsHide still hides it.
  const spawnEdit = { start, end: start + spawn[2]!.length, replacement: detached, patched: spawn[2] === detached };
  return [commandEdit, spawnEdit];
}

export function hasRuntimeBrowserUrlOpening(runtime: string): boolean {
  try { return inspect(runtime).every(edit => edit.patched); } catch { return false; }
}

export function patchRuntimeBrowserUrlOpening(runtime: string): string {
  for (const { start, end, replacement, patched } of inspect(runtime).sort((a, b) => b.start - a.start)) {
    if (!patched) runtime = runtime.slice(0, start) + replacement + runtime.slice(end);
  }
  return runtime;
}
