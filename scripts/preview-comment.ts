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
  getPullRequest: (number: number) => Promise<PreviewPullRequest>
): Promise<{ sha: string; pullRequest?: number }> {
  const number = authorizePreview(context);
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
      "This preview uses the selected commit; later PR updates require another `/pkg-pr-new` comment.");
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
  if (process.argv[2] === "resolve") {
    const target = await resolvePreviewTarget(context, number => githubApi(`pulls/${number}`));
    await appendFile(process.env.GITHUB_OUTPUT!, `sha=${target.sha}\npr_number=${target.pullRequest ?? ""}\n`);
    console.log(`Selected ${target.pullRequest ? `PR #${target.pullRequest}` : "default branch"} at ${target.sha}.`);
  } else if (process.argv[2] === "report") {
    const number = authorizePreview(context);
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
