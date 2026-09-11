import type { TuiScenario } from "../scenarios/types.ts";
import { ScenarioWorkspace } from "./scenario-workspace.ts";
import { TerminalSession } from "./terminal-session.ts";

export async function runAutomatedTuiScenario(scenario: TuiScenario): Promise<void> {
  await using workspace = await ScenarioWorkspace.create({
    files: scenario.files,
    prefix: `zcode-${scenario.name}-`
  });
  await using session = TerminalSession.start({
    command: [process.execPath, scenario.fixture],
    workspace
  });
  await scenario.run(session, workspace);
  await session.exit();
}

export async function runManualTuiScenario(scenario: TuiScenario): Promise<number> {
  await using workspace = await ScenarioWorkspace.create({
    files: scenario.files,
    prefix: `zcode-${scenario.name}-`
  });
  console.error(`Scenario: ${scenario.name}`);
  console.error(`Workspace: ${workspace.directory}`);
  console.error("Exit the TUI with /exit. The workspace will then be deleted.");
  const child = Bun.spawn([process.execPath, scenario.fixture], {
    cwd: workspace.directory,
    env: {
      ...process.env,
      ...workspace.environment(),
      CI: "0",
      TERM: process.env.TERM ?? "xterm-256color",
      ZCODE_DISABLE_UPDATE_CHECK: "1",
      ZCODE_TUI_MODE: "regular"
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });
  return await child.exited;
}
