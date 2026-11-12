import { parseExpressionAt, type FunctionExpression, type SwitchCase, type SwitchStatement } from "acorn";

const marker = 'Marketplace manifest not found in git repo:';

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with marketplace Git URL recovery (${detail}).`);
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
  if (!branchSource.includes("Hwo(") || !branchSource.includes("Hae(")) incompatible("URL manifest loader changed");
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
