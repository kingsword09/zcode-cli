import { expect, test } from "bun:test";
import { hasRuntimeAppServerStandaloneAuth as has, patchRuntimeAppServerStandaloneAuth as patch } from "../scripts/runtime-app-server-patches.ts";
import { applyRuntimePatchPlan, runtimePatchPlan } from "../scripts/sync-runtime.ts";

const helper = 'require(require("node:path").join(__dirname,"cli-config.cjs"))';
function fixture(agent = "agent", starter = "start", reporter = "report", env = "env") {
  return `const exports={runZCodeProtocolAgent:()=>${agent},startProcessProviderRegistryRuntime:()=>${starter}};
async function ${agent}(e={}){
  let ${env}=e.env??process.env;
  let store=await deferred({create:label(()=>storage(),"create")});
  let reg=await deferred({create:label(()=>${starter}(${env}),"create")});
  let other=await deferred({create:label(()=>${starter}(otherEnv),"create")});
  log({event:"zcode_protocol.provider_registry.ready",accountRevision:reg.snapshot.sourceRevisions.account});
  const braces="}", regex=/[}]/, template=\`brace } and \${{x:1}.x}\`;
  let rt=reg;
  const decoy={createZCodeApp:()=>app({...merge(args,other.runtime.registryService,other.personalDefaults)})};
  return new Host({createZCodeApp:label((args={})=>app({...merge(args,rt.runtime.registryService,rt.configuredDefaultModelSelection),env:${env}}),"createZCodeApp")});
}
label(${reporter},"createCliProviderRefreshReporter");
function later(){return {create:label(()=>${starter}(laterEnv),"create")}}`;
}

test.each([
  ["agent", "start", "report", "env"], ["a$1", "$s", "r$2", "$env"]
])("patches only the protocol registry and its app with symbols %s", (agent, starter, reporter, env) => {
  const source = fixture(agent, starter, reporter, env);
  const result = patch(source);
  expect(has(source)).toBe(false);
  expect(has(result)).toBe(true);
  expect(result).toContain(`${starter}(${env},${helper}.appServerRegistryOptions(${env},${reporter}))`);
  expect(result).toContain(`${starter}(otherEnv)`);
  expect(result).toContain(`${starter}(laterEnv)`);
  expect(result).toContain("rt.configuredDefaultModelSelection),...rt.providerRuntimeHeadersPort?");
  expect(patch(result)).toBe(result);
});

test("unrelated injected markers cannot satisfy protocol verification", () => {
  const decoy = 'function unrelated(){return {create:r(()=>Other(env,{standalone:{...callbacks(process.stderr)}}),"create"),createZCodeApp:()=>app({...merge(args,other.runtime.registryService,other.configuredDefaultModelSelection),...other.providerRuntimeHeadersPort?{providerRuntimeHeadersPort:other.providerRuntimeHeadersPort}:{}})}}';
  const source = decoy + fixture() + decoy.replace("unrelated", "after");
  expect(has(source)).toBe(false);
  expect(has(patch(source))).toBe(true);
  expect(patch(source)).toContain(decoy);
});

test("a changed registry call cannot redirect the patch to another function", () => {
  const earlier = 'async function earlier(e){let env=e.env??process.env;let x=await deferred({create:r(()=>start(env),"create")})}';
  expect(() => patch(earlier + fixture().replace("start(env)", "start(env,{})")))
    .toThrow("registry options changed");
});

test("the app factory must consume the registry named in the ready event", () => {
  expect(() => patch(fixture().replace("let rt=reg", "let rt=other")))
    .toThrow("app factory uses another registry");
});

test("missing and ambiguous anchors fail without modifying the source", () => {
  for (const source of [fixture() + fixture(), fixture().replace("runZCodeProtocolAgent", "renamed"),
    fixture().replace("createCliProviderRefreshReporter", "renamed"),
    fixture().replace("zcode_protocol.provider_registry.ready", "renamed"),
    fixture().replace("rt.configuredDefaultModelSelection", "rt.otherDefaults")]) {
    expect(has(source)).toBe(false);
    expect(() => patch(source)).toThrow();
  }
});

test("partial patches and overriding auth properties fail verification", () => {
  const patched = patch(fixture());
  const partial = patched.replace(`,${helper}.appServerRegistryOptions(env,report)`, "");
  expect(has(partial)).toBe(false);
  expect(() => patch(partial)).toThrow("partial auth patch");
  expect(() => patch(fixture().replace("env:env}", "providerRuntimeHeadersPort:otherPort,env:env}")))
    .toThrow("request auth port changed");
});

test("auth is required and records applied or already_present, never a silent skip", () => {
  const entry = runtimePatchPlan.find(item => item.id === "app-server-standalone-auth")!;
  expect(entry.requirement).toBe("required");
  const first = applyRuntimePatchPlan(fixture(), [entry]);
  expect(first.reports[0]?.status).toBe("applied");
  expect(applyRuntimePatchPlan(first.runtime, [entry]).reports[0]?.status).toBe("already_present");
  expect(() => applyRuntimePatchPlan("incompatible runtime", [entry])).toThrow("Required runtime patch");
});
