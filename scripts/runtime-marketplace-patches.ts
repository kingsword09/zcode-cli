import { parseExpressionAt, type FunctionExpression, type MemberExpression, type Node, type SwitchCase, type SwitchStatement } from "acorn";

const marker = 'Marketplace manifest not found in git repo:';

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with marketplace Git URL recovery (${detail}).`);
}

function isMember(node: Node, object: string, property: string): boolean {
  if (node.type !== "MemberExpression") return false;
  const member = node as MemberExpression;
  return !member.computed && member.object.type === "Identifier" && member.object.name === object
    && member.property.type === "Identifier" && member.property.name === property;
}

function findSwitch(node: FunctionExpression): SwitchStatement[] {
  const matches: SwitchStatement[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const candidate = value as { type?: string; [key: string]: unknown };
    if (candidate.type === "SwitchStatement") matches.push(candidate as unknown as SwitchStatement);
    for (const [key, child] of Object.entries(candidate)) {
      if (key === "start" || key === "end") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(node.body);
  return matches;
}

function inspect(runtime: string) {
  const anchor = runtime.indexOf(marker);
  if (anchor < 0 || runtime.indexOf(marker, anchor + marker.length) >= 0) incompatible("Git source anchor missing or ambiguous");
  const start = runtime.lastIndexOf("async function ", anchor);
  if (start < 0) incompatible("Git source loader missing");
  const fn = parseExpressionAt(runtime, start, { ecmaVersion: "latest" });
  if (fn.type !== "FunctionExpression" || !fn.id || fn.params.length !== 3
    || fn.params.some(parameter => parameter.type !== "Identifier")) incompatible("loader signature changed");
  const [source, storageRoot, options] = fn.params.map(parameter => (parameter as { name: string }).name);
  const branches = findSwitch(fn).flatMap(statement => statement.cases);
  const urlCases = branches.filter((branch: SwitchCase) => branch.test?.type === "Literal" && branch.test.value === "url");
  const gitCases = branches.filter((branch: SwitchCase) => branch.test?.type === "Literal" && branch.test.value === "git");
  if (urlCases.length !== 1 || gitCases.length !== 1) incompatible("URL or Git source branch missing or ambiguous");
  const urlCase = urlCases[0]!;
  if (urlCase.consequent.length !== 1 || urlCase.consequent[0]?.type !== "BlockStatement") {
    incompatible("URL source branch changed");
  }
  const block = urlCase.consequent[0];
  const branchSource = runtime.slice(block.start, block.end);
  const [load, result] = block.body.slice(-2);
  if (load?.type !== "VariableDeclaration" || load.declarations.length !== 1
    || result?.type !== "ReturnStatement" || result.argument?.type !== "ObjectExpression"
    || result.argument.properties.length !== 1) incompatible("URL manifest loader changed");
  const binding = load.declarations[0]!;
  const manifest = result.argument.properties[0]!;
  if (binding.id.type !== "Identifier" || binding.init?.type !== "AwaitExpression"
    || binding.init.argument.type !== "CallExpression" || binding.init.argument.callee.type !== "Identifier"
    || binding.init.argument.arguments.length !== 3
    || !binding.init.argument.arguments.every((argument, index) => isMember(argument,
      index === 2 ? options! : source!, ["url", "headers", "signal"][index]!))
    || manifest.type !== "Property" || manifest.computed || manifest.key.type !== "Identifier"
    || manifest.key.name !== "manifest" || manifest.value.type !== "CallExpression"
    || manifest.value.callee.type !== "Identifier" || manifest.value.arguments.length !== 1
    || manifest.value.arguments[0]?.type !== "Identifier"
    || manifest.value.arguments[0].name !== binding.id.name) incompatible("URL manifest loader changed");
  const guard = `if(/(?:\\.git(?:[?#].*)?$|\\/_git\\/)/iu.test(${source}.url))return await ${fn.id.name}({...${source},source:"git"},${storageRoot},${options});`;
  const fallbackMarker = `return await ${fn.id.name}({...${source},source:"git"},${storageRoot},${options});`;
  return { start: block.start, insertion: block.start + 1, guard, fallbackMarker, patched: branchSource.includes(fallbackMarker) };
}

export function hasRuntimeMarketplaceGitUrlRecovery(runtime: string): boolean {
  try { return inspect(runtime).patched; } catch { return false; }
}

export function patchRuntimeMarketplaceGitUrlRecovery(runtime: string): string {
  const result = inspect(runtime);
  if (result.patched) return runtime;
  return runtime.slice(0, result.insertion) + result.guard + runtime.slice(result.insertion);
}
