const marker = ".withHeadlessPromptLifecycle(";

export function hasRuntimeHeadlessLifecycle(runtime: string): boolean {
  return runtime.includes(marker);
}

export function patchRuntimeHeadlessLifecycle(runtime: string): string {
  if (hasRuntimeHeadlessLifecycle(runtime)) return runtime;
  const start = /[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\(async\([^)]*\)=>\{if\([A-Za-z_$][\w$]*\.trim\(\)\.length===0\)return ([A-Za-z_$][\w$]*)\.stderr\.write/u.exec(runtime);
  const end = start ? runtime.indexOf('},"runPrompt")', start.index) : -1;
  if (!start || end < 0) {
    throw new Error("ZCode runtime is incompatible with the headless lifecycle patch (runPrompt anchors missing).");
  }
  const bodyStart = start.index + start[0].indexOf("=>{") + 3;
  const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';
  return runtime.slice(0, bodyStart)
    + `return await ${helper}.withHeadlessPromptLifecycle(${start[1]},async()=>{`
    + runtime.slice(bodyStart, end)
    + "})"
    + runtime.slice(end);
}
