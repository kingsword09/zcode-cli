import { parseExpressionAt } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";
const bridge = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';
const wrapper = `${bridge}.withRecursiveWorkspacePathSuggestions`;

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with recursive workspace paths (${detail}).`);
}

function unique<T>(items: T[], detail: string): T {
  if (items.length !== 1) incompatible(`${detail} missing or ambiguous`);
  return items[0]!;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function inspect(runtime: string) {
  const name = unique([...runtime.matchAll(new RegExp(
    `${identifier}\\((${identifier}),"createWorkspacePathSuggestionProvider"\\)`, "gu"
  ))], "provider label")[1]!;
  const declaration = unique([...runtime.matchAll(new RegExp(`function ${escape(name)}\\(`, "gu"))], "provider function");
  const fn = parseExpressionAt(runtime, declaration.index!, { ecmaVersion: "latest" });
  if (fn.type !== "FunctionExpression" || fn.async || fn.params.length !== 1 || fn.params[0]?.type !== "Identifier") {
    incompatible("provider signature changed");
  }
  const source = (node: { start: number; end: number }) => runtime.slice(node.start, node.end);
  const [bindings, returned] = fn.body.body;
  if (fn.body.body.length !== 2 || bindings?.type !== "VariableDeclaration" || bindings.declarations.length !== 2
    || returned?.type !== "ReturnStatement" || !returned.argument) incompatible("provider body changed");
  const [fileSystem, root] = bindings.declarations;
  if (fileSystem?.id.type !== "Identifier" || !fileSystem.init || root?.id.type !== "Identifier" || !root.init) {
    incompatible("provider bindings changed");
  }
  const options = escape(fn.params[0].name);
  if (!new RegExp(`^${options}\\.fileSystemPort\\?\\?${identifier}\\(\\)$`, "u").test(source(fileSystem.init))
    || !new RegExp(`^\\(0,${identifier}\\.resolve\\)\\(${options}\\.workspaceDirectory\\)$`, "u").test(source(root.init))) {
    incompatible("filesystem or workspace binding changed");
  }
  const argument = returned.argument;
  const native = argument.type === "CallExpression" ? argument.arguments[0] : argument;
  if (native?.type !== "ArrowFunctionExpression" || !native.async || native.params.length !== 1
    || native.params[0]?.type !== "Identifier") incompatible("native callback changed");
  const nativeSource = source(native);
  const exclusions = unique([...nativeSource.matchAll(new RegExp(
    `(${identifier})\\.has\\(${identifier}\\.name\\)`, "gu"
  ))], "directory exclusions")[1]!;
  const listing = new RegExp(
    `${escape(fileSystem.id.name)}\\.listDirectory\\(\\{path:${identifier}\\},\\{signal:${escape(native.params[0].name)}\\.abortSignal\\}\\)`, "u"
  );
  if (!listing.test(nativeSource)) incompatible("native directory listing changed");
  const replacement = `${wrapper}(${nativeSource},{workspaceDirectory:${root.id.name},fileSystemPort:${fileSystem.id.name},excludedDirectories:${exclusions}})`;
  if (argument.type === "CallExpression" && source(argument) !== replacement) incompatible("recursive wrapper changed");
  return { start: argument.start, end: argument.end, replacement, patched: argument.type === "CallExpression" };
}

export function hasRuntimeRecursiveWorkspacePaths(runtime: string): boolean {
  try { return inspect(runtime).patched; } catch { return false; }
}

export function patchRuntimeRecursiveWorkspacePaths(runtime: string): string {
  const { start, end, replacement, patched } = inspect(runtime);
  return patched ? runtime : runtime.slice(0, start) + replacement + runtime.slice(end);
}
