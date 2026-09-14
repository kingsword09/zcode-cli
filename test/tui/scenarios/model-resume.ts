import { join } from "node:path";

import { TerminalSession } from "../harness/terminal-session.ts";
import type { TuiScenario } from "./types.ts";

export const modelResumeScenario: TuiScenario = {
  name: "model-resume",
  description: "Restores the last session model instead of the configured default.",
  fixture: join(import.meta.dir, "..", "..", "fixtures", "tui-model-resume.ts"),
  async run(session, workspace) {
    await session.waitForScreen("initial default model", /◈ scenario\/glm-5\.3(?!-flash)/iu);
    await session.sendAndWait(
      "/model scenario/glm-5.3-flash\r",
      "switch to flash model",
      /Session model now: scenario\/glm-5\.3-flash/iu
    );
    await session.sendAndWait(
      "new request after model switch\r",
      "request on flash model",
      /Echo: new request after model switch/iu
    );
    await session.exit();

    await using resumedSession = TerminalSession.start({
      command: [process.execPath, modelResumeScenario.fixture],
      workspace
    });
    await resumedSession.waitForScreen("resumed initial default model", /◈ scenario\/glm-5\.3(?!-flash)/iu);
    await resumedSession.sendAndWait(
      "/resume fixture-session\r",
      "resume response",
      /Resumed session fixture-session/iu
    );
    await resumedSession.waitForScreen("restored session model", /◈ scenario\/glm-5\.3-flash/iu);
    await resumedSession.sendAndWait("/status\r", "status model", /Model\s+scenario\/glm-5\.3-flash/iu);
    await resumedSession.sendAndWait("\x1b", "close status", /◈ scenario\/glm-5\.3-flash/iu);
    await resumedSession.exit();
  },
  async manualRun(workspace) {
    const runStage = async (label: string): Promise<number> => {
      console.error(`\n${label}`);
      const child = Bun.spawn([process.execPath, modelResumeScenario.fixture], {
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
    };

    const firstExitCode = await runStage([
      "Stage 1: start the session.",
      "Switch with /model scenario/glm-5.3-flash, send a request, then exit with /exit."
    ].join("\n"));
    if (firstExitCode !== 0) return firstExitCode;
    return await runStage([
      "Stage 2: the process was restarted.",
      "Run /resume fixture-session, inspect /status, then exit with /exit."
    ].join("\n"));
  }
};
