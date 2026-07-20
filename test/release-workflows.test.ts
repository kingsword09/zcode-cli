import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

const root = resolve(import.meta.dir, "..");
const actionShas = {
  checkout: "df4cb1c069e1874edd31b4311f1884172cec0e10",
  downloadArtifact: "d3f86a106a0bac45b974a628896c90dbdf5c8093",
  setupBun: "0c5077e51419868618aeaa5fe8019c62421857d6",
  setupNode: "249970729cb0ef3589644e2896645e5dc5ba9c38",
  uploadArtifact: "ea165f8d65b6e75b540449e92b4886f43607fa02"
} as const;

interface WorkflowStep {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  if?: string;
  needs?: string;
  outputs?: Record<string, unknown>;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps: WorkflowStep[];
  "timeout-minutes"?: number;
}

interface Workflow {
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  jobs: Record<string, WorkflowJob>;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
}

async function readWorkflow(name: string): Promise<{ source: string; workflow: Workflow }> {
  const source = await Bun.file(resolve(root, ".github", "workflows", name)).text();
  return { source, workflow: parse(source) as Workflow };
}

function findAction(steps: WorkflowStep[], repository: string, sha: string): WorkflowStep | undefined {
  return steps.find((step) => step.uses === `${repository}@${sha}`);
}

async function runInlineVersionComparator(source: string, left: string, right: string): Promise<string> {
  const script = /compare_release_versions\(\) \{[\s\S]*?<<'NODE'\n([\s\S]*?)\n\s*NODE\n\s*\}/u
    .exec(source)?.[1];
  if (!script) throw new Error("Could not extract the privileged release version comparator.");

  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, LEFT_VERSION: left, RIGHT_VERSION: right },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `Comparator exited with status ${code}.`);
  return stdout.trim();
}

describe("release workflows", () => {
  test("runs read-only CI with pinned actions and cancels superseded checks", async () => {
    const { source, workflow } = await readWorkflow("ci.yml");
    const job = workflow.jobs.validate!;
    const checkout = findAction(job.steps, "actions/checkout", actionShas.checkout);
    const setupNode = findAction(job.steps, "actions/setup-node", actionShas.setupNode);
    const setupBun = findAction(job.steps, "oven-sh/setup-bun", actionShas.setupBun);
    const install = job.steps.find((step) => step.name === "Install dependencies");
    const build = job.steps.find((step) => step.name === "Build and test");
    const pack = job.steps.find((step) => step.name === "Pack and install-test");
    const metadata = job.steps.find((step) => step.name === "Verify repository and npm metadata");

    expect(workflow.on).toHaveProperty("push");
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency?.group).toContain("github.event.pull_request.number");
    expect(workflow.concurrency?.group).toContain("github.ref");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBe(45);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(setupNode?.with?.["node-version"]).toBe("22.19.0");
    expect(setupNode?.with?.["package-manager-cache"]).toBe(false);
    expect(setupBun).toBeDefined();
    expect(install?.run).toBe("bun install --frozen-lockfile");
    expect(build?.run).toBe("bun run release:build");
    expect(pack?.run).toBe("bun run release:pack");
    expect(metadata?.run).toContain("npm pkg fix --dry-run --json");
    expect(metadata?.run).toContain("git diff --check");
    expect(metadata?.run).toContain("git diff --exit-code -- package.json zcode-runtime.lock.json");
    expect(source).not.toContain("NPM_TOKEN");
    expect(source).not.toContain("npm publish");
    expect(source).not.toContain("id-token: write");
  });

  test("prepares release PRs only from the default branch with pinned actions", async () => {
    const { source, workflow } = await readWorkflow("prepare-release.yml");
    const job = workflow.jobs.prepare!;
    const steps = job.steps;
    const checkout = findAction(steps, "actions/checkout", actionShas.checkout);
    const setupNode = findAction(steps, "actions/setup-node", actionShas.setupNode);
    const setupBun = findAction(steps, "oven-sh/setup-bun", actionShas.setupBun);
    const releaseBuild = steps.find((step) => step.name === "Build and validate release candidate");
    const releaseMetadata = steps.find((step) => step.name === "Prepare release metadata");
    const createPullRequest = steps.find((step) => step.name === "Create or update release pull request");

    expect(workflow.on).toHaveProperty("schedule");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    expect(job.if).toContain("github.event_name == 'schedule'");
    expect(job.if).toContain("github.ref_name == github.event.repository.default_branch");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(setupNode?.with?.["package-manager-cache"]).toBe(false);
    expect(setupBun).toBeDefined();
    expect(releaseBuild?.run).toBe("bun run release:prepare");
    expect(releaseMetadata?.env?.BASE_VERSION).toBe("${{ steps.base.outputs.package_version }}");
    expect(releaseMetadata?.run).toContain(
      "compareReleaseVersions(process.env.PACKAGE_VERSION, process.env.BASE_VERSION) > 0"
    );
    expect(createPullRequest?.uses).toBe(
      "peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1"
    );
    expect(createPullRequest?.with?.["add-paths"]).toContain("package.json");
    expect(createPullRequest?.with?.["add-paths"]).toContain("zcode-runtime.lock.json");
    expect(createPullRequest?.with?.branch).toBe("${{ steps.release.outputs.branch }}");
    expect(source).not.toContain("NPM_TOKEN");
    expect(source).not.toContain("npm publish");
  });

  test("validates releases without write credentials before the privileged publish job", async () => {
    const { source, workflow } = await readWorkflow("publish.yml");
    const validate = workflow.jobs.validate!;
    const publishJob = workflow.jobs.publish!;
    const validateCheckout = findAction(validate.steps, "actions/checkout", actionShas.checkout);
    const publishCheckout = findAction(publishJob.steps, "actions/checkout", actionShas.checkout);
    const setupNode = findAction(publishJob.steps, "actions/setup-node", actionShas.setupNode);
    const setupBun = findAction(validate.steps, "oven-sh/setup-bun", actionShas.setupBun);
    const upload = findAction(validate.steps, "actions/upload-artifact", actionShas.uploadArtifact);
    const download = findAction(publishJob.steps, "actions/download-artifact", actionShas.downloadArtifact);
    const releaseBuild = validate.steps.find((step) => step.name === "Build committed release");
    const packageCheck = validate.steps.find((step) => step.name === "Pack and install-test release");
    const driftCheck = validate.steps.find((step) => step.name === "Verify release did not drift");
    const transferCheck = publishJob.steps.find((step) => step.name === "Verify validated tarball");
    const rebuild = publishJob.steps.find((step) => step.name === "Rebuild tarball without project scripts");
    const stateCheck = publishJob.steps.find((step) => step.name === "Inspect release state");
    const publishIndex = publishJob.steps.findIndex(
      (step) => step.name === "Publish to npm with Trusted Publishing"
    );
    const tagIndex = publishJob.steps.findIndex((step) => step.name === "Create immutable Git tag");
    const releaseIndex = publishJob.steps.findIndex((step) => step.name === "Create GitHub Release");
    const publish = publishJob.steps[publishIndex];

    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.permissions).toEqual({});
    expect(validate.permissions).toEqual({ contents: "read" });
    expect(publishJob.permissions).toEqual({ contents: "write", "id-token": "write" });
    expect(publishJob.needs).toBe("validate");
    expect(validate.if).toContain("github.ref_name == github.event.repository.default_branch");
    expect(validate.if).toContain("github.event.pull_request.merged == true");
    expect(validate.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(validate.if).toContain("release/zcode-cli");
    expect(validate.if).toContain("release/zcode-upstream");
    expect(validateCheckout?.with?.["persist-credentials"]).toBe(false);
    expect(publishCheckout?.with?.["persist-credentials"]).toBe(false);
    expect(setupNode?.with?.["node-version"]).toBe(24);
    expect(setupNode?.with?.["package-manager-cache"]).toBe(false);
    expect(setupBun).toBeDefined();
    expect(publishJob.steps.some((step) => step.run?.includes("bun"))).toBe(false);
    expect(publishJob.steps.some((step) => step.name === "Install dependencies")).toBe(false);
    expect(releaseBuild?.run).toBe("bun run release:build");
    expect(packageCheck?.run).toContain("bun run release:pack");
    expect(packageCheck?.run).toContain("cp .release/release.json");
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
    expect(upload?.with?.path).toBe("release-artifact");
    expect(download?.with?.name).toContain("needs.validate.outputs.artifact_name");
    expect(driftCheck?.run).toContain("git diff --exit-code -- package.json");
    expect(driftCheck?.run).toContain("zcode-runtime.lock.json");
    expect(transferCheck?.run).toContain("release.json");
    expect(rebuild?.run).toContain("tar -xzf");
    expect(rebuild?.run).toContain("npm pack ./.release/publish/package");
    expect(rebuild?.run).toContain("--ignore-scripts");
    expect(rebuild?.run).toContain("cmp --");
    expect(stateCheck?.run).toContain("gitHead");
    expect(stateCheck?.run).toContain("TAG_COMMIT");
    await expect(runInlineVersionComparator(stateCheck!.run!, "3.3.7-1", "3.3.6-99")).resolves.toBe("1");
    await expect(runInlineVersionComparator(stateCheck!.run!, "3.3.6-5", "3.3.6-5")).resolves.toBe("0");
    await expect(runInlineVersionComparator(stateCheck!.run!, "3.3.6-4", "3.3.6-5")).resolves.toBe("-1");
    expect(publish?.run).toBe(
      "npm publish ./.release/publish/package --ignore-scripts --access public --tag latest"
    );
    expect(publish?.env).toBeUndefined();
    expect(publishIndex).toBeGreaterThan(-1);
    expect(tagIndex).toBeGreaterThan(publishIndex);
    expect(releaseIndex).toBeGreaterThan(tagIndex);
    expect(source).not.toContain("NPM_TOKEN");
    expect(source).not.toContain("npm@latest");
    expect(source).toContain("npm@12.0.1");
    expect(source).toContain("gh api --method POST");
  });

  test("removes the direct scheduled publishing workflow", () => {
    expect(existsSync(resolve(root, ".github", "workflows", "sync-and-publish.yml"))).toBe(false);
  });
});
