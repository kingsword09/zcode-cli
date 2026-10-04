import { parseExpressionAt, type ObjectExpression, type SequenceExpression } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";
const bridge = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with configuration diagnostics (${detail}).`);
}

function unique<T>(items: T[], name: string): T {
  if (items.length !== 1) incompatible(`${name} missing or ambiguous`);
  return items[0]!;
}

function inspect(runtime: string) {
  const tag = unique([...runtime.matchAll(/,"runDoctor"\)/gu)], "doctor label").index!;
  const prefixes = [...runtime.slice(0, tag).matchAll(new RegExp(
    `${identifier}=${identifier}\\((\\((${identifier}),(${identifier}),(${identifier})\\)=>\\{)`, "gu"
  ))];
  const prefix = prefixes.at(-1);
  if (!prefix) incompatible("doctor function missing");
  const start = prefix.index! + prefix[0].indexOf(prefix[1]!);
  // Stop before the label argument so Acorn cannot consume it as a comma expression.
  const fn = parseExpressionAt(runtime.slice(0, tag), start, { ecmaVersion: "latest" });
  if (fn.type !== "ArrowFunctionExpression" || fn.body.type !== "BlockStatement" || fn.end !== tag) incompatible("doctor function changed");
  const report = unique(fn.body.body.flatMap(statement => statement.type === "VariableDeclaration"
    ? statement.declarations.filter(binding => binding.init?.type === "ObjectExpression"
      && ["cli", "runtime", "packaging"].every(key => (binding.init as ObjectExpression).properties.some(property =>
        property.type === "Property" && property.key.type === "Identifier" && property.key.name === key
      ))) : []), "doctor report");
  if (report.id.type !== "Identifier" || report.init?.type !== "ObjectExpression") incompatible("doctor report changed");
  const jsonBranch = unique(fn.body.body.filter(statement => statement.type === "IfStatement"
    && statement.test.type === "MemberExpression" && statement.test.property.type === "Identifier"
    && statement.test.property.name === "json"), "doctor JSON branch");
  if (jsonBranch.type !== "IfStatement" || jsonBranch.consequent.type !== "ReturnStatement"
    || jsonBranch.consequent.argument?.type !== "SequenceExpression") incompatible("doctor JSON return changed");
  const textReturn = unique(fn.body.body.filter(statement => statement.type === "ReturnStatement"), "doctor text return");
  if (textReturn.type !== "ReturnStatement" || textReturn.argument?.type !== "SequenceExpression") incompatible("doctor text return changed");
  const result = report.id.name;
  const parse = unique([...runtime.matchAll(new RegExp(`${identifier}\\((${identifier}),"createConfig"\\)`, "gu"))], "native config factory");
  const init = [...runtime.slice(0, parse.index).matchAll(new RegExp(`(${identifier})=${identifier}\\(\\(\\)=>\\{`, "gu"))].at(-1)?.[1];
  if (!init) incompatible("native config initializer missing");
  return {
    report: report.init, result, streams: prefix[2]!, cwd: prefix[4]!, factory: parse[1]!, init,
    jsonReturn: jsonBranch.consequent.argument, textReturn: textReturn.argument
  };
}

export function hasRuntimeConfigurationDiagnostics(runtime: string): boolean {
  if (!runtime.includes(".inspectRuntimeConfiguration(")) return false;
  try {
    const inspected = inspect(runtime);
    const source = runtime.slice(inspected.report.start, inspected.report.end);
    return source.includes(`${bridge}.inspectRuntimeConfiguration(${inspected.cwd},$zOptions=>{${inspected.init}();return ${inspected.factory}($zOptions)})`)
      && runtime.slice(inspected.jsonReturn.start, inspected.jsonReturn.end).endsWith(`${inspected.result}.configuration.ok?0:1`)
      && runtime.slice(inspected.textReturn.start, inspected.textReturn.end).endsWith(`${bridge}.writeConfigurationDoctor(${inspected.streams}.stdout,${inspected.result}.configuration)`);
  } catch { return false; }
}

export function patchRuntimeConfigurationDiagnostics(runtime: string): string {
  if (hasRuntimeConfigurationDiagnostics(runtime)) return runtime;
  if (runtime.includes(".inspectRuntimeConfiguration(")) incompatible("partial patch");
  const { report, result, streams, cwd, factory, init, jsonReturn, textReturn } = inspect(runtime);
  const endCode = (expression: SequenceExpression) => {
    const last = expression.expressions.at(-1)!;
    if (last.type !== "Literal" || last.value !== 0) incompatible("doctor exit code changed");
    return last;
  };
  const jsonCode = endCode(jsonReturn), textCode = endCode(textReturn);
  const edits = [
    { start: report.end - 1, end: report.end - 1, text: `,configuration:${bridge}.inspectRuntimeConfiguration(${cwd},$zOptions=>{${init}();return ${factory}($zOptions)})` },
    { start: jsonCode.start, end: jsonCode.end, text: `${result}.configuration.ok?0:1` },
    { start: textCode.start, end: textCode.end, text: `${bridge}.writeConfigurationDoctor(${streams}.stdout,${result}.configuration)` }
  ];
  for (const edit of edits.sort((left, right) => right.start - left.start)) runtime = runtime.slice(0, edit.start) + edit.text + runtime.slice(edit.end);
  return runtime;
}
