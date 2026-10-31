import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hasRuntimeStartPlan, patchRuntimeStartPlan } from "../../scripts/runtime-start-plan-patches.ts";

const root = join(import.meta.dir, "../..");

// Minimal stand-in for the vendored runtime: the four account functions the
// Start Plan patches touch, in their real (pristine, minified) statement
// shapes. Escapes are doubled where the outer template would consume them, so
// the fixture string carries the same literal \uXXXX / ${...} text as bundle.
const fixture = `
var K3n=require("node:crypto");
async function Y3n(e,t){if(t)return{zcodeBuiltinRevision:t.revision,providers:t.providers.entries().flatMap(([i,a])=>{let c=a.access,u=a.builtinModelIds?.find(f=>f.trim())?.trim();return c?.type==="zhipu-account"&&c.mode==="individual-coding-plan"&&c.accountType&&u?[{family:c.accountType,modelId:u,providerId:i}]:[]})};throw new Error(\`\${VG} is required for login\`)}
r(Y3n,"readStandaloneCodingPlanCatalog");
async function Kgi(e,t){let n=(await Z3n(t)).filter(o=>o.family===e);if(n.length!==1)throw new Error(\`ZCode Built-in Config \\u5FC5\\u987B\\u4E3A \${e} \\u58F0\\u660E\\u552F\\u4E00 Individual Coding Plan Provider\`);return n[0]}
r(Kgi,"resolveStandaloneCodingPlanProvider");
function fW(e){let t=e.trim();if(!t)throw new Error("Standalone Account Provider ID \\u4E0D\\u80FD\\u4E3A\\u7A7A");return\`account-provider:\${t}:identity\`}
r(fW,"standaloneAccountIdentityCredentialKey");
function Ygi(e){return{async refreshBeforeModelRequest(c){let u=c.providerId.trim(),f=c.accountAccess,_=f.accountType;if(!f||f.mode!=="individual-coding-plan")throw new Error(\`Standalone Account Provider \\u8BF7\\u6C42\\u8EAB\\u4EFD\\u65E0\\u6548: \${u}\`);let h=(await e.load(fW(u)))?.trim();if(!h)throw new Error("Standalone Account Provider \\u51ED\\u8BC1\\u5DF2\\u7ECF\\u5931\\u6548: "+u);let v=bX(u),S=await e.load(v),k=J3n(_),I=S==="manual"?void 0:(await e.load(k))?.trim(),C=S==="oauth"||S!=="manual"&&!!I,R,D,B;if(C){R=await exchange()}else if(S==="manual"){R=(await e.load($5e({providerId:u,accountIdentity:h})))?.trim()}if(!C&&S!=="manual")throw new Error("project_token_login_required");if(c.abortSignal?.throwIfAborted(),!R)throw new Error(\`Standalone Account Provider \\u7F3A\\u5C11\\u8BF7\\u6C42\\u51ED\\u636E: \${u}\`);return{headersApplied:!0,requestAuth:{apiKey:R,...D?{apiKeyId:D}:{},...B?{accountScope:B}:{}}}}}}
r(Ygi,"createStandaloneProviderRuntimeHeadersPort");
`;

test("patched fixture admits Start Plan providers and is idempotent", () => {
  expect(hasRuntimeStartPlan(fixture)).toBe(false);
  const patched = patchRuntimeStartPlan(fixture);
  expect(hasRuntimeStartPlan(patched)).toBe(true);
  expect(patchRuntimeStartPlan(patched)).toBe(patched);
  expect(patched).toContain('c.mode==="individual-coding-plan"||c.mode==="start-plan"');
  expect(patched).toContain('!/-start-plan$/.test(o.providerId)');
  expect(patched).toContain('t.replace(/-start-plan$/u,"-individual-coding-plan")');
  expect(patched).toContain('f.mode!=="individual-coding-plan"&&f.mode!=="start-plan"');
  expect(patched).toContain('(await e.load("zcodejwttoken"))?.trim()');
});

test("Start Plan identity resolves to the family Coding Plan identity credential", () => {
  const patched = patchRuntimeStartPlan(fixture);
  // Label/env stubs only; the function under test touches none of the others.
  const fW = new Function("require", "r", "VG", "jM", "Z3n", "bX", "J3n", "$5e", `${patched}\nreturn fW;`)(
    (id: string) => (id === "node:crypto" ? {} : undefined),
    () => {},
    "VG", class {}, async () => [],
    () => "auth-source", () => "oauth", () => "api-key",
  ) as (id: string) => string;
  expect(fW("account:zai-individual-coding-plan")).toBe("account-provider:account:zai-individual-coding-plan:identity");
  expect(fW("account:zai-start-plan")).toBe("account-provider:account:zai-individual-coding-plan:identity");
  expect(fW("account:bigmodel-start-plan")).toBe("account-provider:account:bigmodel-individual-coding-plan:identity");
  expect(fW("account:zai-team-coding-plan")).toBe("account-provider:account:zai-team-coding-plan:identity");
});

test("synced runtime ships standalone Start Plan support", async () => {
  const runtime = await readFile(join(root, "vendor/zcode.cjs"), "utf8");
  expect(hasRuntimeStartPlan(runtime)).toBe(true);
  expect(patchRuntimeStartPlan(runtime)).toBe(runtime);
});
