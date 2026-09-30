import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { authorizePreview, previewComment, previewPackageLinks, resolvePreviewTarget, type PreviewContext,
  type PreviewPullRequest } from "../scripts/preview-comment.ts";

const mainSha = "a".repeat(40), headSha = "b".repeat(40);
function context(): PreviewContext {
  return { repository: "kingsword09/zcode-cli", actorId: "19650362", triggeringActor: "kingsword09",
    eventName: "issue_comment", ref: "refs/heads/main", sha: mainSha,
    event: { action: "created", repository: { default_branch: "main" },
      comment: { body: "/pkg-pr-new", user: { id: 19650362 } }, issue: { number: 180, pull_request: {} } } };
}
function pull(): PreviewPullRequest {
  return { number: 180, state: "open", base: { repo: { full_name: "kingsword09/zcode-cli" } },
    head: { sha: headSha, repo: { full_name: "contributor/zcode-cli" } } };
}

test("an owner comment resolves the fork's exact head, not the default branch or merge commit", async () => {
  const requested: number[] = [];
  const target = await resolvePreviewTarget(context(), async number => { requested.push(number); return pull(); });
  expect(requested).toEqual([180]);
  expect(target).toEqual({ sha: headSha, pullRequest: 180 });
});

test.each([
  ["another commenter", (c: PreviewContext) => { c.actorId = "1"; c.triggeringActor = "collaborator"; c.event.comment!.user!.id = 1; }],
  ["another rerunner", (c: PreviewContext) => { c.triggeringActor = "collaborator"; }],
  ["an owner actor with someone else's comment", (c: PreviewContext) => { c.event.comment!.user!.id = 1; }],
  ["an edited comment", (c: PreviewContext) => { c.event.action = "edited"; }],
  ["a regular issue", (c: PreviewContext) => { delete c.event.issue!.pull_request; }],
  ["a quoted command", (c: PreviewContext) => { c.event.comment!.body = "Please run /pkg-pr-new"; }],
  ["shell input", (c: PreviewContext) => { c.event.comment!.body = "/pkg-pr-new; echo nope"; }],
  ["a code block", (c: PreviewContext) => { c.event.comment!.body = "```\n/pkg-pr-new\n```"; }],
  ["a fork workflow", (c: PreviewContext) => { c.repository = "contributor/zcode-cli"; }],
  ["an untrusted workflow branch", (c: PreviewContext) => { c.ref = "refs/heads/contributor"; }],
  ["a PR push event", (c: PreviewContext) => { c.eventName = "pull_request"; }]
] as const)("rejects %s before making any API request", async (_name, change) => {
  const input = context();
  change(input);
  let apiCalls = 0;
  await expect(resolvePreviewTarget(input, async () => { apiCalls++; return pull(); })).rejects.toThrow();
  expect(apiCalls).toBe(0);
});

test.each([
  ["closed PR", (p: PreviewPullRequest) => { p.state = "closed"; }],
  ["wrong repository", (p: PreviewPullRequest) => { p.base.repo.full_name = "other/repo"; }],
  ["wrong PR", (p: PreviewPullRequest) => { p.number = 181; }],
  ["deleted fork", (p: PreviewPullRequest) => { p.head.repo = null; }],
  ["invalid SHA", (p: PreviewPullRequest) => { p.head.sha = "main\npr_number=999"; }]
] as const)("rejects %s returned by the API", async (_name, change) => {
  const response = pull();
  change(response);
  await expect(resolvePreviewTarget(context(), async () => response)).rejects.toThrow();
});

test("manual PR selection is owner-only and accepts numbers rather than refs or shell syntax", async () => {
  const input = context();
  input.eventName = "workflow_dispatch";
  input.event.inputs = { pull_request: "180" };
  expect(await resolvePreviewTarget(input, async () => pull())).toEqual({ sha: headSha, pullRequest: 180 });
  for (const number of ["0", "-1", "180;echo nope", "1\nsha=main", "main", "9007199254740992"]) {
    input.event.inputs.pull_request = number;
    expect(() => authorizePreview(input)).toThrow();
  }
  input.event.inputs.pull_request = "180";
  input.actorId = "1";
  expect(() => authorizePreview(input)).toThrow("Only kingsword09");
});

test("default-branch pushes and owner manual runs retain default-branch previews", async () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    const input = context();
    input.eventName = eventName;
    expect(await resolvePreviewTarget(input, async () => { throw new Error("No PR lookup expected"); }))
      .toEqual({ sha: mainSha });
  }
});

test("success reports contain the pinned package URL and failures never invent a package link", () => {
  const shortUrl = `https://pkg.pr.new/zcode-app-cli@${headSha.slice(0, 7)}`;
  const success = previewComment(headSha, "success", "12345", shortUrl);
  expect(success).toContain(`npx --yes ${shortUrl}`);
  expect(success).toContain(`[Full repository URL](https://pkg.pr.new/kingsword09/zcode-cli/zcode-app-cli@${headSha})`);
  expect(success).toContain("/actions/runs/12345");
  expect(previewComment(headSha, "failure", "12345")).not.toContain("https://pkg.pr.new");
  expect(() => previewComment(headSha, "cancelled", "12345")).toThrow();
  expect(() => previewComment("`malicious`", "success", "12345")).toThrow();
  expect(() => previewComment(headSha, "success", "12345)evil")).toThrow();
});

test("publication may return compact or full URLs while preserving the emitted SHA spelling", () => {
  const fullUrl = `https://pkg.pr.new/kingsword09/zcode-cli/zcode-app-cli@${headSha}`;
  for (const url of [`https://pkg.pr.new/zcode-app-cli@${headSha.slice(0, 7)}`, `https://pkg.pr.new/zcode-app-cli@${headSha}`, fullUrl]) {
    expect(previewPackageLinks(headSha, url)).toEqual({ url, fullUrl });
  }
  const fallback = previewComment(headSha, "success", "12345", fullUrl);
  expect(fallback).toContain(`npx --yes ${fullUrl}`);
  expect(fallback).not.toContain("[Full repository URL]");
});

test.each([
  `https://pkg.pr.new/zcode-app-cli@${mainSha.slice(0, 7)}`,
  `https://pkg.pr.new/other/repo/zcode-app-cli@${headSha}`,
  `https://evil.test/zcode-app-cli@${headSha}`,
  `https://pkg.pr.new/another-package@${headSha}`,
  `https://pkg.pr.new/zcode-app-cli@${headSha}?other=1`,
  "https://pkg.pr.new/zcode-app-cli@main",
  "https://pkg.pr.new/zcode-app-cli@bbbbbb",
  undefined
])("rejects an unverified preview URL: %s", url => {
  expect(() => previewPackageLinks(headSha, url)).toThrow();
});

test("the workflow helper runs in native Node without installing PR dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-preview-comment-"));
  try {
    const eventPath = join(directory, "event.json"), output = join(directory, "output");
    await writeFile(eventPath, JSON.stringify({ repository: { default_branch: "main" } }));
    const child = Bun.spawn([Bun.which("node")!, resolve(import.meta.dir, "../scripts/preview-comment.ts"), "resolve"], {
      cwd: directory, env: { ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
        GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "kingsword09/zcode-cli",
        GITHUB_ACTOR_ID: "19650362", GITHUB_TRIGGERING_ACTOR: "kingsword09", GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main", GITHUB_SHA: mainSha }, stdout: "pipe", stderr: "pipe"
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(await readFile(output, "utf8")).toBe(`sha=${mainSha}\npr_number=\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
