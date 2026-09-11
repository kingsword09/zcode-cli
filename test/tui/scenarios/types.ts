import type { ScenarioWorkspace } from "../harness/scenario-workspace.ts";
import type { TerminalSession } from "../harness/terminal-session.ts";

export interface TuiScenario {
  name: string;
  description: string;
  fixture: string;
  files?: Record<string, string | Uint8Array>;
  run(session: TerminalSession, workspace: ScenarioWorkspace): Promise<void>;
}
