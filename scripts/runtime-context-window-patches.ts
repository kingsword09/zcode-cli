import {
  parseExpressionAt,
  type CallExpression,
  type FunctionExpression,
  type MemberExpression,
  type ReturnStatement
} from "acorn";

const identifier = "[A-Za-z_$][\\w$]*";
/*
 * The runtime resolves a model's context window for the request budget and for
 * auto-compaction, but the product-state projection keeps the 200000 default:
 * `contextWindow` is only ever assigned by the `session_created` event, and
 * current runtimes no longer append that event when a session starts. Everything
 * hosts read (the /context header, the runtime state, the session settings and
 * the headless `--json` projection) therefore disagreed with the window in use.
 *
 * Merge the window resolved from the session's model catalog entry into the
 * projected state, so every consumer sees what the budget uses. Models without a
 * declared window keep the recorded projection value.
 */
function replacementFor(events: string): string {
  return "let $zState=this.eventReducer.reduce(" + events + "),"
    + "$zModels=this.modelCatalogPort?.listModels(),"
    + "$zCurrent=$zModels?.find($zModel=>$zModel.current),"
    + "$zWindow=$zCurrent?.contextWindow;"
    + "return typeof $zWindow!=\"number\"||!Number.isFinite($zWindow)||$zWindow<=0"
    + "?$zState:{...$zState,contextWindow:$zWindow}";
}

const patchMarker = "let $zState=this.eventReducer.reduce(";

function incompatible(detail: string): never {
  throw new Error(`ZCode runtime is incompatible with the resolved context window (${detail}).`);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function labelledFunction(runtime: string, label: string): FunctionExpression {
  const labels = [...runtime.matchAll(new RegExp(`${identifier}\\((${identifier}),"${label}"\\)`, "gu"))];
  if (labels.length !== 1) incompatible(`${label} label missing or ambiguous`);
  const symbol = labels[0]![1]!;
  const declarations = [...runtime.matchAll(new RegExp(`(?:async )?function ${escape(symbol)}\\(`, "gu"))];
  if (declarations.length !== 1) incompatible(`${label} function missing or ambiguous`);
  const fn = parseExpressionAt(runtime, declarations[0]!.index!, { ecmaVersion: "latest" });
  if (fn.type !== "FunctionExpression" || fn.id?.name !== symbol) incompatible(`${label} function changed`);
  return fn;
}

/** `this.eventReducer.reduce(events)` — the product-state input for a projection. */
function reducedEvents(statement: ReturnStatement | undefined): string | undefined {
  const argument = statement?.argument;
  if (argument?.type !== "CallExpression") return undefined;
  const call = argument as CallExpression;
  const callee = call.callee;
  if (callee.type !== "MemberExpression" || call.arguments.length !== 1) return undefined;
  const member = callee as MemberExpression;
  if (member.computed || member.property.type !== "Identifier" || member.property.name !== "reduce") return undefined;
  const receiver = member.object;
  if (receiver.type !== "MemberExpression" || receiver.computed
    || receiver.property.type !== "Identifier" || receiver.property.name !== "eventReducer"
    || receiver.object.type !== "ThisExpression") return undefined;
  const events = call.arguments[0];
  return events?.type === "Identifier" ? events.name : undefined;
}

function inspect(runtime: string) {
  const projection = labelledFunction(runtime, "rebuildProjection");
  if (projection.params.length !== 0) incompatible("rebuildProjection signature changed");
  if (runtime.slice(projection.body.start, projection.body.end).includes(patchMarker)) {
    return { start: 0, end: 0, replacement: "", patched: true };
  }
  const returns = projection.body.body.filter((node): node is ReturnStatement => node.type === "ReturnStatement");
  if (returns.length !== 1) incompatible("rebuildProjection no longer returns the reduced event state");
  const events = reducedEvents(returns[0]);
  if (!events) incompatible("rebuildProjection no longer returns the reduced event state");
  return {
    start: returns[0]!.start,
    end: returns[0]!.end,
    replacement: replacementFor(events),
    patched: false
  };
}

export function hasRuntimeResolvedContextWindow(runtime: string): boolean {
  try { return inspect(runtime).patched; } catch { return false; }
}

export function patchRuntimeResolvedContextWindow(runtime: string): string {
  const { start, end, replacement, patched } = inspect(runtime);
  return patched ? runtime : runtime.slice(0, start) + replacement + runtime.slice(end);
}
