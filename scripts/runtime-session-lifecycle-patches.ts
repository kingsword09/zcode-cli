const identifier = "[A-Za-z_$][\\w$]*";
const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function unique(source: string, pattern: RegExp, name: string): RegExpMatchArray {
  const matches = [...source.matchAll(new RegExp(pattern.source, "gu"))];
  if (matches.length !== 1) throw new Error(`ZCode runtime is incompatible with session lifecycle (${name} missing or ambiguous).`);
  return matches[0]!;
}

export function hasRuntimeSessionLifecycle(runtime: string): boolean {
  return runtime.includes(`${helper}.ensureSessionForTitle(this,`)
    && runtime.includes("$zValidatedResumeSession=")
    && runtime.includes("$zResumeCandidateError")
    && runtime.includes("$zTuiResumeReady=")
    && runtime.includes("$zTuiResumeOptions=")
    && runtime.includes('"readSessionResumeTarget"');
}

export function patchRuntimeSessionLifecycle(runtime: string): string {
  if (hasRuntimeSessionLifecycle(runtime)) return runtime;
  let patched = runtime;
  if (!patched.includes(`${helper}.ensureSessionForTitle(this,`)) {
    const title = unique(patched, new RegExp(`${identifier}\\((${identifier}),"setCustomSessionTitle"\\)`, "u"), "custom title method");
    const prefix = unique(patched, new RegExp(`async function ${escape(title[1]!)}\\((${identifier})\\)\\{`, "u"), "custom title function");
    patched = patched.replace(prefix[0], `${prefix[0]}await ${helper}.ensureSessionForTitle(this,${prefix[1]});`);
  }
  if (!patched.includes("$zValidatedResumeSession=")) {
    const store = unique(patched, new RegExp(`(${identifier})=(${identifier})\\.sessionStore===void 0,(${identifier})=\\2\\.sessionStore\\?\\?await ${identifier}\\(${identifier},${identifier}\\),`, "u"), "app session store");
    patched = patched.replace(store[0], `${store[0]}$zValidatedResumeSession=${store[2]}.resume?await ${helper}.assertResumableSession(${store[3]},${store[2]}.sessionId).catch(async $zResumeStoreError=>{if(${store[1]})await ${store[3]}.close();throw $zResumeStoreError}):void 0,`);
  }
  if (!patched.includes('"readSessionResumeTarget"')) {
    const facade = unique(patched, new RegExp(`setCustomSessionTitle:(${identifier})\\(async (${identifier})=>(${identifier})\\.runtime\\.setCustomSessionTitle\\(\\{title:\\2\\.title,traceContext:\\2\\.traceContext\\?\\?\\3\\.traceContext\\}\\),"setCustomSessionTitle"\\)`, "u"), "app title facade");
    patched = patched.replace(facade[0], `${facade[0]},readSessionResumeTarget:${facade[1]}(async()=>await ${helper}.readSessionResumeTarget(${facade[3]}),"readSessionResumeTarget")`);
  }
  if (!patched.includes("$zResumeCandidateError")) {
    const switchApp = unique(patched, new RegExp(`(${identifier})\\(async (${identifier})=>\\{let (${identifier})=(${identifier}),(${identifier})=await \\2\\(\\);return \\4=\\5,\\3&&\\3!==\\5&&await (${identifier})\\(\\3\\),`, "u"), "app replacement");
    const createApp = unique(patched, new RegExp(`return (${identifier})\\.current=(${identifier})\\((${identifier}),${identifier}\\(\\1\\)\\),\\3\\},"createApp"\\)`, "u"), "candidate app publication");
    patched = patched.replace(switchApp[0], switchApp[0].replace(";return ", `;try{await ${switchApp[5]}.readExecutionState()}catch($zResumeCandidateError){await ${switchApp[6]}(${switchApp[5]});throw $zResumeCandidateError}return `));
    patched = patched.replace(createApp[0], `return ${createApp[3]}},"createApp")`);
  }
  if (!patched.includes("$zTuiResumeReady=")) {
    const cleanup = unique(patched, new RegExp(`cleanup:${identifier}\\(async\\(\\)=>\\{await (${identifier})\\.close\\?\\.\\(\\)\\},"cleanup"\\)`, "u"), "TUI app cleanup");
    const options = unique(patched, new RegExp(`${escape(cleanup[1]!)}=${identifier}\\(${identifier},${identifier},${identifier},(${identifier}),${identifier}\\.locale,`, "u"), "TUI resume options");
    const startTui = unique(patched, new RegExp(`try\\{return await (${identifier})\\(\\{loadStartupOptions:`, "u"), "TUI startup");
    patched = patched.replace(startTui[0], `try{let $zTuiResumeOptions=${options[1]},$zTuiResumeReady=($zTuiResumeOptions.resumeSessionId||$zTuiResumeOptions.continueSession)?await ${cleanup[1]}.readExecutionState?.():void 0;return await ${startTui[1]}({loadStartupOptions:`);
  } else if (!patched.includes("$zTuiResumeOptions=")) {
    const cleanup = unique(patched, new RegExp(`cleanup:${identifier}\\(async\\(\\)=>\\{await (${identifier})\\.close\\?\\.\\(\\)\\},"cleanup"\\)`, "u"), "TUI app cleanup");
    const options = unique(patched, new RegExp(`${escape(cleanup[1]!)}=${identifier}\\(${identifier},${identifier},${identifier},(${identifier}),${identifier}\\.locale,`, "u"), "TUI resume options");
    patched = patched.replace(`let $zTuiResumeReady=await ${cleanup[1]}.readExecutionState?.();`, `let $zTuiResumeOptions=${options[1]},$zTuiResumeReady=($zTuiResumeOptions.resumeSessionId||$zTuiResumeOptions.continueSession)?await ${cleanup[1]}.readExecutionState?.():void 0;`);
  }
  if (!hasRuntimeSessionLifecycle(patched)) throw new Error("Session lifecycle patch failed postcondition verification.");
  return patched;
}
