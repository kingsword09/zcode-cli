import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const repository = "kingsword09/zcode-cli";
const ownerId = "19650362";
const ownerLogin = "kingsword09";
export const previewCommand = "/pkg-pr-new";

export interface PreviewContext {
  repository: string;
  actorId: string;
  triggeringActor: string;
  eventName: string;
  ref: string;
  sha: string;
  event: {
    action?: string;
    repository?: { default_branch?: string };
    comment?: { body?: string; user?: { id?: number } };
    issue?: { number?: number; pull_request?: object };
    inputs?: { pull_request?: string };
    workflow_run?: {
      name?: string;
      path?: string;
      event?: string;
      conclusion?: string;
      head_sha?: string;
      repository?: { full_name?: string };
      pull_requests?: { number: number }[];
    };
  };
}

function pullRequestNumber(value: unknown): number {
  if (!/^[1-9]\d*$/u.test(String(value))) throw new Error("A positive pull request number is required.");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Invalid pull request number.");
  return number;
}

function commitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) throw new Error("Invalid preview commit SHA.");
  return value;
}

/** No API calls or PR code execution until the event and identity are authorized. */
export function authorizePreview(context: PreviewContext): number | undefined {
  if (context.repository !== repository
    || context.ref !== `refs/heads/${context.event.repository?.default_branch}`) {
    throw new Error("Preview requests must use this repository's default-branch workflow.");
  }
  if (context.eventName === "push") return undefined;
  if (context.eventName === "workflow_run") {
    const run = context.event.workflow_run;
    if (context.event.action !== "completed" || run?.name !== "CI"
      || run.path !== ".github/workflows/ci.yml" || run.event !== "pull_request"
      || run.conclusion !== "success" || run.repository?.full_name !== repository) {
      throw new Error("Automatic previews require a successful PR CI run in this repository.");
    }
    commitSha(run.head_sha);
    return undefined;
  }
  if (context.actorId !== ownerId || context.triggeringActor !== ownerLogin) {
    throw new Error("Only kingsword09 may request or rerun a preview.");
  }
  if (context.eventName === "issue_comment") {
    if (context.event.action !== "created" || !context.event.issue?.pull_request
      || context.event.comment?.user?.id !== Number(ownerId)
      || context.event.comment.body !== previewCommand) {
      throw new Error("Expected a new /pkg-pr-new PR comment from kingsword09.");
    }
    return pullRequestNumber(context.event.issue.number);
  }
  if (context.eventName === "workflow_dispatch") {
    const number = context.event.inputs?.pull_request;
    return number ? pullRequestNumber(number) : undefined;
  }
  throw new Error("Unsupported preview event.");
}

export interface PreviewPullRequest {
  number: number;
  state: string;
  base: { repo: { full_name: string } };
  head: { sha: string; repo: object | null };
}

export async function resolvePreviewTarget(
  context: PreviewContext,
  getPullRequest: (number: number) => Promise<PreviewPullRequest>,
  getCommitPullRequests: (sha: string) => Promise<{ number: number }[]> = async () => []
): Promise<{ sha: string; pullRequest?: number } | undefined> {
  const number = authorizePreview(context);
  if (context.eventName === "workflow_run") {
    const run = context.event.workflow_run!;
    const sha = commitSha(run.head_sha);
    // GitHub may omit pull_requests on CI runs from forks. Resolve those by
    // commit, then verify the current PR state before checking out any PR code.
    const candidates = run.pull_requests?.length ? run.pull_requests : await getCommitPullRequests(sha);
    const targets: number[] = [];
    for (const candidate of new Set(candidates.map(pull => pullRequestNumber(pull.number)))) {
      const pull = await getPullRequest(candidate);
      if (pull.number === candidate && pull.state === "open" && pull.base.repo.full_name === repository
        && pull.head.repo && pull.head.sha === sha) targets.push(candidate);
    }
    if (targets.length > 1) throw new Error("CI commit matches more than one open PR.");
    // A superseded CI run must not publish an old commit or cancel a newer build.
    return targets.length === 1 ? { sha, pullRequest: targets[0]! } : undefined;
  }
  if (number === undefined) return { sha: commitSha(context.sha) };
  const pull = await getPullRequest(number);
  if (pull.number !== number || pull.state !== "open" || pull.base.repo.full_name !== repository || !pull.head.repo) {
    throw new Error("Preview target must be an open PR in this repository with an available head repository.");
  }
  return { sha: commitSha(pull.head.sha), pullRequest: number };
}

export function previewPackageLinks(sha: string, publishedUrl: unknown): { url: string; fullUrl: string } {
  sha = commitSha(sha);
  const match = typeof publishedUrl === "string"
    ? /^https:\/\/pkg\.pr\.new\/(?:kingsword09\/zcode-cli\/)?zcode-app-cli@([0-9a-f]{7,40})$/u.exec(publishedUrl)
    : null;
  if (!match || !sha.startsWith(match[1]!)) throw new Error("Published package URL does not match the selected preview commit.");
  return { url: publishedUrl as string, fullUrl: `https://pkg.pr.new/${repository}/zcode-app-cli@${sha}` };
}

export function previewComment(sha: string, result: string, runId: string, publishedUrl?: string): string {
  sha = commitSha(sha);
  if (!/^\d+$/u.test(runId)) throw new Error("Invalid workflow run ID.");
  const run = `https://github.com/${repository}/actions/runs/${runId}`;
  const lines = [`pkg-pr-new preview for commit \`${sha}\`.`, ""];
  if (result === "success") {
    const { url, fullUrl } = previewPackageLinks(sha, publishedUrl);
    lines.push("```sh", `npx --yes ${url}`, "```", "");
    if (url !== fullUrl) lines.push(`[Full repository URL](${fullUrl})`, "");
    lines.push(
      "This preview uses the selected commit. PR updates publish automatically after CI succeeds; kingsword09 can also request a preview with `/pkg-pr-new`.");
  } else if (result === "failure") {
    lines.push("The preview build or publication failed. No new preview link is available from this run.");
  } else {
    throw new Error("Only completed preview builds may post a result.");
  }
  lines.push("", `[Workflow logs](${run})`);
  return lines.join("\n");
}

async function githubApi(endpoint: string, options: { method?: string; body?: object } = {}) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN is required.");
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    signal: AbortSignal.timeout(30_000),
    method: options.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json",
      "x-github-api-version": "2022-11-28" },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${endpoint}.`);
  return response.json();
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, "utf8"));
  const context: PreviewContext = {
    repository: process.env.GITHUB_REPOSITORY!, actorId: process.env.GITHUB_ACTOR_ID!,
    triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR!, eventName: process.env.GITHUB_EVENT_NAME!,
    ref: process.env.GITHUB_REF!, sha: process.env.GITHUB_SHA!, event
  };
  const resolveTarget = () => resolvePreviewTarget(context,
    number => githubApi(`pulls/${number}`),
    sha => githubApi(`commits/${sha}/pulls?per_page=100`));
  if (process.argv[2] === "resolve") {
    const target = await resolveTarget();
    if (!target) {
      await appendFile(process.env.GITHUB_OUTPUT!, "sha=\npr_number=\n");
      console.log("Skipping CI preview: no open PR still points to the validated commit.");
      return;
    }
    await appendFile(process.env.GITHUB_OUTPUT!, `sha=${target.sha}\npr_number=${target.pullRequest ?? ""}\n`);
    console.log(`Selected ${target.pullRequest ? `PR #${target.pullRequest}` : "default branch"} at ${target.sha}.`);
  } else if (process.argv[2] === "report") {
    let number = authorizePreview(context);
    if (context.eventName === "workflow_run") {
      const target = await resolveTarget();
      if (!target) {
        console.log("Skipping CI preview report: the PR has closed or moved to another commit.");
        return;
      }
      if (target.sha !== process.env.PREVIEW_SHA) throw new Error("Preview result does not match the CI commit.");
      number = target.pullRequest;
    }
    if (number === undefined || number !== pullRequestNumber(process.env.PREVIEW_PR_NUMBER)) {
      throw new Error("Preview result does not belong to the requested PR.");
    }
    const body = previewComment(process.env.PREVIEW_SHA!, process.env.PREVIEW_RESULT!, process.env.GITHUB_RUN_ID!, process.env.PREVIEW_URL);
    // This job only executes the trusted workflow revision, never PR scripts.
    await githubApi(`issues/${number}/comments`, { method: "POST", body: { body } });
  } else {
    throw new Error("Expected resolve or report.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
