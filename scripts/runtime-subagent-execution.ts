import { parseExpressionAt } from "acorn";

const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';

function replaceOnce(source: string, pattern: RegExp, change: (...match: string[]) => string): string {
  if ([...source.matchAll(new RegExp(pattern.source, "gu"))].length !== 1) {
    throw new Error(`Incompatible subagent runtime anchor: ${pattern.source}`);
  }
  return source.replace(pattern, change);
}

function patchFunction(source: string, label: string, edit: (body: string) => string): string {
  const name = new RegExp(`\\(([\\w$]+),"${label}"\\)`, "u").exec(source)?.[1];
  const start = name && source.indexOf(`function ${name}(`);
  if (typeof start !== "number" || start < 0) throw new Error(`Missing runtime function ${label}`);
  const offset = source.slice(start - 6, start) === "async " ? start - 6 : start;
  const fn = parseExpressionAt(source, offset, { ecmaVersion: "latest" });
  return source.slice(0, offset) + edit(source.slice(offset, fn.end)) + source.slice(fn.end);
}

/** Wrap the complete launch, including detached child work tracked by the port. */
function ownExecution(method: string, resume: boolean): string {
  const wrapped = replaceOnce(method, /([\w$]+\.register\([\w$]+\(\{isBackgrounded:![01],lifecycle:([\w$]+),)/u,
    (match, _registration, lifecycle) => `return ${helper}.withSubagentExecution(${lifecycle},${resume},async()=>{${match}`);
  return wrapped.slice(0, -1) + "})}";
}

export function patchSubagentExecution(runtime: string): string {
  if (runtime.includes(".withSubagentExecution(")) {
    if (runtime.split(".withSubagentExecution(").length !== 4 || !runtime.includes(".trackSubagentExecution(")
      || !runtime.includes("!==$zHistory&&") || !runtime.includes(".subagentExecutionState(")) {
      throw new Error("Incomplete subagent execution patch. Sync from the original runtime.");
    }
    return runtime;
  }
  runtime = patchFunction(runtime, "createExploreSubagentPort", port => {
    port = replaceOnce(port, /(\([\w$]+,[\w$]+=!1\)=>\()([\w$]+\.add\(([\w$]+)\))/u,
      (_match, start, add, work) => `${start}${helper}.trackSubagentExecution(${work}),${add}`);
    for (const [name, next] of [["run", "start"], ["start", "getTask"]]) {
      const begin = port.indexOf(`,async ${name}(`);
      const end = port.indexOf(`,async ${next}(`, begin + 1);
      if (begin < 0 || end < 0) throw new Error(`Missing subagent ${name} method`);
      port = port.slice(0, begin) + ownExecution(port.slice(begin, end), false) + port.slice(end);
    }
    return port;
  });
  runtime = patchFunction(runtime, "resumeTerminalAgentInBackground", body => ownExecution(body, true));
  for (const writer of ["writeAgentMetadataFile", "writeStoppedAgentArtifacts"]) {
    runtime = patchFunction(runtime, writer, body => replaceOnce(body,
      /agentId:([\w$]+)\.agentId,childSessionId:\1\.childSessionId/u,
      (match, task) => `${match},executionId:${task}.executionId`));
  }
  runtime = patchFunction(runtime, "restoreLocalAgentTaskFromRunMetadata", body => {
    const output = /([\w$]+)=[\w$]+\.findTranscriptAgentOutputFile\?\./u.exec(body)?.[1];
    if (!output) throw new Error("Missing transcript output file for subagent ownership");
    return replaceOnce(body, /([\w$]+)\(([\w$]+)\.status,([\w$]+)\);if\(!/u,
      (_m, status, run, updated) => `${run}.status==="running"?(${helper}.subagentExecutionState(${output},${run}.childSessionId)==="released"?"failed":void 0):${status}(${run}.status,${updated});if(!`);
  });
  runtime = patchFunction(runtime, "collectPreviousRuntimeAgentInterruptions", body =>
    replaceOnce(body, /(let\{agentId:[\w$]+,childSessionId:([\w$]+),outputFile:([\w$]+)\}=[\w$]+;)/u,
      (match, _declaration, child, output) => `${match}if(${helper}.subagentExecutionState(${output},${child})!=="released")continue;`));
  // TaskOutput may read a historical result without granting TaskStop or
  // SendMessage access through the live registry.
  runtime = patchFunction(runtime, "getTaskOutputInputFailure", body =>
    replaceOnce(body, /!([\w$]+)\.get\(([\w$]+\.task_id)\)/u,
      (match, registry, id) => `${match}&&!${helper}.historicalTaskOutput(${registry},${id})`));
  runtime = replaceOnce(runtime, /let ([\w$]+)=([\w$]+\(([\w$]+)\))\.get\(([\w$]+)\.task_id\);if\(!\1\)(return [^;]+);if\(!\4\.block\)/u,
    (_m, task, registry, _context, input, fail) =>
      `let $zHistory=${helper}.historicalTaskOutput(${registry},${input}.task_id),${task}=${registry}.get(${input}.task_id)??$zHistory;if(!${task})${fail};if(!${input}.block||${task}===$zHistory)`);
  return replaceOnce(runtime, /(if\(![\w$]+\.block\|\|([\w$]+)===\$zHistory\)\{[^}]+?\.abortSignal\),)([\w$]+\(\2,[\w$]+\))/u,
    (_match, branch, task, notify) => `${branch}${task}!==$zHistory&&${notify}`);
}
