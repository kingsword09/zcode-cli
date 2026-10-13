const identifier = "[A-Za-z_$][\\w$]*";

export function patchRuntimeWorkflowManagement(runtime: string): string {
  if (runtime.includes("createTuiWorkflowManagement({")) return runtime;
  const dependency = (label: string) => {
    const marker = new RegExp(`${identifier}\\((${identifier}),"${label}"\\)`, "u").exec(runtime);
    const init = marker && [...runtime.slice(0, marker.index).matchAll(
      /([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\(\)=>\{/gu
    )].at(-1)?.[1];
    if (!marker || !init) throw new Error(`ZCode runtime is incompatible with workflow management (${label} missing).`);
    return { symbol: marker[1], init };
  };
  const list = dependency("listSavedWorkflowsOp");
  const read = dependency("getSavedWorkflowOp");
  const save = dependency("saveSavedWorkflowFromRunOp");
  const journal = dependency("resolveDynamicWorkflowJournalStore");
  const facade = /listDynamicWorkflowRuns:[A-Za-z_$][\w$]*\(async ([A-Za-z_$][\w$]*)=>([A-Za-z_$][\w$]*)\.listRunsForSession\(\1\.limit\),"listDynamicWorkflowRuns"\)/u.exec(runtime);
  const queries = /([A-Za-z_$][\w$]*)\.listWorkflowRuns=async\(\)=>await\(await ([A-Za-z_$][\w$]*)\(\)\)\.listDynamicWorkflowRuns\?\.\(\{\}\)\?\?\[\]/u.exec(runtime);
  const option = /replayWorkflowRuns:([A-Za-z_$][\w$]*)\.replayWorkflowRuns/u.exec(runtime);
  const context = facade && /context:\{sessionId:([A-Za-z_$][\w$]*),workingDirectory:([A-Za-z_$][\w$]*)\}/u.exec(runtime.slice(facade.index));
  const store = facade && new RegExp(`${journal.symbol}\\((${identifier}),${identifier}\\)`, "u").exec(runtime.slice(Math.max(0, facade.index - 40_000), facade.index));
  if (!facade || !queries || !option || !context || !store) {
    throw new Error("ZCode runtime is incompatible with workflow management (facade/query anchors missing).");
  }
  const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';
  const extension = `${facade[0]},...${helper}.createTuiWorkflowManagement({port:${facade[2]},sessionId:${context[1]},cwd:${context[2]},sessionStore:${store[1]},native:{`
    + `list:async $zParams=>{${list.init}();return await ${list.symbol}({},$zParams)},`
    + `read:async $zParams=>{${read.init}();return await ${read.symbol}({},$zParams)},`
    + `save:async($zContext,$zParams)=>{${save.init}();return await ${save.symbol}($zContext,$zParams)}}})`;
  const methods = ["retuneWorkflowConcurrency", "listSavedWorkflows", "readSavedWorkflow", "saveWorkflowRun", "startSavedWorkflow"];
  const queryExtension = methods.map(method => method === "startSavedWorkflow"
    ? `${queries[1]}.${method}=async $zInput=>${helper}.startTuiSavedWorkflow(await ${queries[2]}(),$zInput)`
    : `${queries[1]}.${method}=async $zInput=>{let $zApp=await ${queries[2]}();if(typeof $zApp.${method}!=="function")throw new Error("Workflow management is unavailable in this runtime.");return await $zApp.${method}($zInput)}`).join(",");
  return runtime.replace(facade[0], extension)
    .replace(queries[0], `${queries[0]},${queryExtension}`)
    .replace(option[0], `${option[0]},${methods.map(method => `${method}:${option[1]}.${method}`).join(",")}`);
}
