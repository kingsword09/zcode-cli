#!/usr/bin/env bun

import { findTuiScenario, listTuiScenarios } from "../test/tui/scenarios/index.ts";
import {
  runAutomatedTuiScenario,
  runManualTuiScenario,
  type ScenarioWorkspaceBackendName
} from "../test/tui/harness/run-scenario.ts";

const args = process.argv.slice(2);
const workspaceBackendArgument = args.find((arg) => arg.startsWith("--workspace-backend="));
const workspaceBackend = workspaceBackendArgument?.slice("--workspace-backend=".length) ?? "disk";
if (workspaceBackend !== "disk" && workspaceBackend !== "mountx") {
  throw new Error(`Unknown workspace backend "${workspaceBackend}". Expected disk or mountx.`);
}
const runOptions = {
  workspaceBackend: workspaceBackend as ScenarioWorkspaceBackendName
};
if (args.includes("--list")) {
  for (const scenario of listTuiScenarios()) {
    console.log(`${scenario.name}\t${scenario.description}`);
  }
  process.exit(0);
}

const manual = args.includes("--manual");
const all = args.includes("--all");
if (manual && all) throw new Error("--manual requires one scenario and cannot be combined with --all.");
if (all) {
  for (const scenario of listTuiScenarios()) {
    await runAutomatedTuiScenario(scenario, runOptions);
    console.log(`TUI scenario passed: ${scenario.name}`);
  }
  process.exit(0);
}
const name = args.find((arg) => !arg.startsWith("-")) ?? "permission-request-queue";
const scenario = findTuiScenario(name);

if (manual) {
  process.exitCode = await runManualTuiScenario(scenario, runOptions);
} else {
  await runAutomatedTuiScenario(scenario, runOptions);
  console.log(`TUI scenario passed: ${scenario.name}`);
}
