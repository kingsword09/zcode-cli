import { parseExpressionAt, type Node, type CallExpression, type Property, type SpreadElement,
  type AssignmentExpression, type VariableDeclarator } from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";
const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with app-server auth (${detail}).`);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function unique<T>(items: T[], anchor: string): T {
  if (items.length !== 1) incompatible(`${anchor} missing or ambiguous`);
  return items[0]!;
}

function walk(node: Node, visit: (node: Node, ancestors: Node[]) => void, ancestors: Node[] = []): void {
  visit(node, ancestors);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === "object" && typeof child.type === "string") {
        walk(child, visit, [...ancestors, node]);
      }
    }
  }
}

function inspect(runtime: string) {
  const exported = (name: string) => unique(
    [...runtime.matchAll(new RegExp(`${name}:\\(\\)=>(${identifier})(?=[,}])`, "gu"))], name
  )[1]!;
  const agent = exported("runZCodeProtocolAgent");
  const starter = exported("startProcessProviderRegistryRuntime");
  const reporter = unique([...runtime.matchAll(new RegExp(
    `${identifier}\\((${identifier}),"createCliProviderRefreshReporter"\\)`, "gu"
  ))], "refresh reporter")[1]!;
  const start = unique([...runtime.matchAll(new RegExp(`(?:async )?function ${escape(agent)}\\(`, "gu"))], "protocol function").index!;
  // Parse only the named function. Braces inside strings, templates, regexes and
  // nested functions cannot move the boundary into another runtime surface.
  const fn = parseExpressionAt(runtime, start, { ecmaVersion: "latest" });
  if (fn.type !== "FunctionExpression" || fn.id?.name !== agent) incompatible("protocol function changed");
  const source = runtime.slice(fn.start, fn.end);
  if (!source.includes('event:"zcode_protocol.provider_registry.ready"')) incompatible("registry ready event missing");
  const calls: { call: CallExpression; result: string }[] = [];
  const readyRegistries: string[] = [];
  const aliases = new Map<string, string>();
  const factories: { spread: SpreadElement; object: Node; registry: string }[] = [];
  walk(fn.body, (node, ancestors) => {
    if (node.type === "VariableDeclarator") {
      const binding = node as VariableDeclarator;
      if (binding.id.type === "Identifier" && binding.init?.type === "Identifier") aliases.set(binding.id.name, binding.init.name);
    }
    if (node.type === "Property") {
      const property = node as Property;
      const parent = ancestors.at(-1);
      if (property.key.type === "Identifier" && property.key.name === "event"
        && property.value.type === "Literal" && property.value.value === "zcode_protocol.provider_registry.ready"
        && parent?.type === "ObjectExpression") {
        const registry = /accountRevision:([A-Za-z_$][\w$]*)\.snapshot\.sourceRevisions\.account/u
          .exec(runtime.slice(parent.start, parent.end))?.[1];
        if (registry) readyRegistries.push(registry);
      }
    }
    if (node.type === "CallExpression") {
      const call = node as CallExpression;
      if (call.callee.type === "Identifier" && call.callee.name === starter) {
        for (const ancestor of ancestors.toReversed()) {
          const binding = ancestor.type === "VariableDeclarator" ? ancestor as VariableDeclarator : undefined;
          const assignment = ancestor.type === "AssignmentExpression" ? ancestor as AssignmentExpression : undefined;
          const target = binding?.id ?? assignment?.left;
          const value = binding?.init ?? assignment?.right;
          if (target?.type === "Identifier" && value?.type === "AwaitExpression") {
            calls.push({ call, result: target.name });
            break;
          }
        }
      }
    }
    if (node.type !== "SpreadElement") return;
    const spread = node as SpreadElement;
    const object = ancestors.at(-1);
    if (object?.type !== "ObjectExpression" || spread.argument.type !== "CallExpression") return;
    const isFactory = ancestors.some(parent => {
      if (parent.type !== "Property") return false;
      const property = parent as Property;
      return !property.computed && property.key.type === "Identifier" && property.key.name === "createZCodeApp";
    });
    if (!isFactory) return;
    const args = spread.argument.arguments;
    if (args.length !== 3) return;
    const registry = new RegExp(`^(${identifier})\\.runtime\\.registryService$`, "u").exec(runtime.slice(args[1]!.start, args[1]!.end))?.[1];
    if (registry && runtime.slice(args[2]!.start, args[2]!.end) === `${registry}.configuredDefaultModelSelection`) {
      factories.push({ spread, object, registry });
    }
  });
  const readyRegistry = unique(readyRegistries, "registry ready event");
  const call = unique(calls.filter(item => item.result === readyRegistry), "protocol registry call").call;
  const env = call.arguments[0];
  if (env?.type !== "Identifier" || !new RegExp(
    `(?:let|const|var) ${escape(env.name)}=${identifier}\\.env\\?\\?process\\.env;`, "u"
  ).test(source)) incompatible("protocol env binding changed");
  const options = `${helper}.appServerRegistryOptions(${env.name},${reporter})`;
  const factory = unique(factories, "protocol app factory");
  let registry = factory.registry;
  const seen = new Set<string>();
  while (aliases.has(registry) && !seen.has(registry)) {
    seen.add(registry);
    registry = aliases.get(registry)!;
  }
  if (registry !== readyRegistry) incompatible("app factory uses another registry");
  const headers = `...${factory.registry}.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:${factory.registry}.providerRuntimeHeadersPort}:{}`;
  const registryPatched = call.arguments.length === 2
    && runtime.slice(call.arguments[1]!.start, call.arguments[1]!.end) === options;
  if (!registryPatched && call.arguments.length !== 1) incompatible("registry options changed");
  const objectSource = runtime.slice(factory.object.start, factory.object.end);
  const headersPatched = runtime.slice(factory.spread.end, factory.spread.end + headers.length + 1) === `,${headers}`;
  // Reject unexpected later properties that could override our auth port.
  const mentions = objectSource.match(/providerRuntimeHeadersPort/gu)?.length ?? 0;
  if (mentions !== (headersPatched ? 3 : 0)) incompatible("request auth port changed");
  if (registryPatched !== headersPatched) incompatible("partial auth patch");
  return { call, options, factory, headers, patched: registryPatched && headersPatched };
}

export function hasRuntimeAppServerStandaloneAuth(runtime: string): boolean {
  try { return inspect(runtime).patched; } catch { return false; }
}

export function patchRuntimeAppServerStandaloneAuth(runtime: string): string {
  const shape = inspect(runtime);
  if (shape.patched) return runtime;
  const edits = [
    { at: shape.call.end - 1, text: `,${shape.options}` },
    { at: shape.factory.spread.end, text: `,${shape.headers}` }
  ].sort((left, right) => right.at - left.at);
  let patched = runtime;
  for (const edit of edits) patched = patched.slice(0, edit.at) + edit.text + patched.slice(edit.at);
  if (!hasRuntimeAppServerStandaloneAuth(patched)) incompatible("auth patch verification failed");
  return patched;
}
