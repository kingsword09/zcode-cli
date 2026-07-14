import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

const root = resolve(import.meta.dir, "..");

interface WorkflowStep {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  jobs: Record<string, {
    if?: string;
    steps: WorkflowStep[];
  }>;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
}

async function readWorkflow(name: string): Promise<{ source: string; workflow: Workflow }> {
  const source = await Bun.file(resolve(root, ".github", "workflows", name)).text();
  return { source, workflow: parse(source) as Workflow };
}

describe("release workflows", () => {
  test("prepares reviewed release PRs without publishing credentials", async () => {
    const { source, workflow } = await readWorkflow("prepare-release.yml");
    const steps = workflow.jobs.prepare!.steps;
    const checkout = steps.find((step) => step.uses === "actions/checkout@v6");
    const setupNode = steps.find((step) => step.uses === "actions/setup-node@v6");
    const releaseMetadata = steps.find((step) => step.name === "Prepare release metadata");
    const createPullRequest = steps.find((step) => step.name === "Create or update release pull request");

    expect(workflow.on).toHaveProperty("schedule");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(setupNode?.with?.["package-manager-cache"]).toBe(false);
    expect(releaseMetadata?.env?.BASE_VERSION).toBe("${{ steps.base.outputs.package_version }}");
    expect(releaseMetadata?.run).toContain("compareReleaseVersions(process.env.PACKAGE_VERSION, process.env.BASE_VERSION) > 0");
    expect(createPullRequest?.uses).toBe(
      "peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1"
    );
    expect(createPullRequest?.with?.["add-paths"]).toContain("package.json");
    expect(createPullRequest?.with?.["add-paths"]).toContain("zcode-runtime.lock.json");
    expect(createPullRequest?.with?.branch).toBe("${{ steps.release.outputs.branch }}");
    expect(source).not.toContain("NPM_TOKEN");
    expect(source).not.toContain("npm publish");
  });

  test("publishes only merged release PRs or explicit manual runs", async () => {
    const { source, workflow } = await readWorkflow("publish.yml");
    const job = workflow.jobs.publish!;
    const steps = job.steps;
    const checkout = steps.find((step) => step.uses === "actions/checkout@v6");
    const setupNode = steps.find((step) => step.uses === "actions/setup-node@v6");
    const driftCheck = steps.find((step) => step.name === "Verify release did not drift");
    const stateCheck = steps.find((step) => step.name === "Inspect release state");
    const publishIndex = steps.findIndex((step) => step.name === "Publish to npm with Trusted Publishing");
    const tagIndex = steps.findIndex((step) => step.name === "Create immutable Git tag");
    const releaseIndex = steps.findIndex((step) => step.name === "Create GitHub Release");
    const publish = steps[publishIndex];

    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.permissions).toEqual({ contents: "write", "id-token": "write" });
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(checkout?.with?.["fetch-tags"]).toBe(true);
    expect(setupNode?.with?.["node-version"]).toBe(24);
    expect(setupNode?.with?.["package-manager-cache"]).toBe(false);
    expect(job.if).toContain("github.event.pull_request.merged == true");
    expect(job.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(job.if).toContain("release/zcode-cli");
    expect(job.if).toContain("release/zcode-upstream");
    expect(driftCheck?.run).toContain("ACTUAL_VERSION");
    expect(driftCheck?.run).toContain("git diff --exit-code -- package.json");
    expect(driftCheck?.run).toContain("zcode-runtime.lock.json");
    expect(stateCheck?.run).toContain("gitHead");
    expect(stateCheck?.run).toContain("TAG_COMMIT");
    expect(publish?.run).toBe("npm publish --access public --tag latest");
    expect(publish?.env).toBeUndefined();
    expect(publishIndex).toBeGreaterThan(-1);
    expect(tagIndex).toBeGreaterThan(publishIndex);
    expect(releaseIndex).toBeGreaterThan(tagIndex);
    expect(source).not.toContain("NPM_TOKEN");
    expect(source).not.toContain("--provenance");
  });

  test("removes the direct scheduled publishing workflow", () => {
    expect(existsSync(resolve(root, ".github", "workflows", "sync-and-publish.yml"))).toBe(false);
  });
});
