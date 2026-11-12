import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "acorn";
import {
  hasRuntimeMarketplaceGitUrlRecovery,
  patchRuntimeMarketplaceGitUrlRecovery
} from "../../scripts/runtime-marketplace-patches.ts";

const root = new URL("../..", import.meta.url);
const fixture = `
async function eko(e,t,n){switch(e.source){case"url":{let o=await Hwo(e.url,e.headers,n.signal);return{manifest:Hae(o)}}case"git":{let o=await jwo(e.url,e.ref,e.sparsePaths,n.signal);if(!o)throw new Error("Marketplace manifest not found in git repo:"+e.url);return{manifest:Hae(o)}}}}
`;

test("legacy .git URL sources refresh through Git instead of bare HTTP", async () => {
  const patched = patchRuntimeMarketplaceGitUrlRecovery(fixture);
  expect(hasRuntimeMarketplaceGitUrlRecovery(patched)).toBe(true);
  expect(patchRuntimeMarketplaceGitUrlRecovery(patched)).toBe(patched);
  expect(() => parse(patched, { ecmaVersion: "latest" })).not.toThrow();

  const calls: string[] = [];
  const loader = new Function("Hwo", "Hae", "jwo", `return (${patched})`)(
    async () => { calls.push("http"); throw new Error("bare GET is unsupported"); },
    (value: unknown) => value,
    async (url: string) => { calls.push(`git:${url}`); return { name: "git-marketplace" }; }
  ) as (source: unknown, storageRoot: unknown, options: unknown) => Promise<unknown>;

  await expect(loader({ source: "url", url: "https://git.example.com/market.git" }, {}, { signal: undefined }))
    .resolves.toEqual({ manifest: { name: "git-marketplace" } });
  expect(calls).toEqual(["git:https://git.example.com/market.git"]);
});

test("ordinary URL marketplaces keep the manifest HTTP path", async () => {
  const patched = patchRuntimeMarketplaceGitUrlRecovery(fixture);
  const calls: string[] = [];
  const loader = new Function("Hwo", "Hae", "jwo", `return (${patched})`)(
    async (url: string) => { calls.push(`http:${url}`); return { name: "http-marketplace" }; },
    (value: unknown) => value,
    async () => { calls.push("git"); return {}; }
  ) as (source: unknown, storageRoot: unknown, options: unknown) => Promise<unknown>;

  await expect(loader({ source: "url", url: "https://example.com/marketplace.json" }, {}, { signal: undefined }))
    .resolves.toEqual({ manifest: { name: "http-marketplace" } });
  expect(calls).toEqual(["http:https://example.com/marketplace.json"]);
});

test("the checked-in runtime accepts recovery patches", async () => {
  const runtime = await Bun.file(new URL("vendor/zcode.cjs", root)).text();
  const patched = patchRuntimeMarketplaceGitUrlRecovery(runtime);
  expect(hasRuntimeMarketplaceGitUrlRecovery(patched)).toBe(true);
  expect(patchRuntimeMarketplaceGitUrlRecovery(patched)).toBe(patched);
});
