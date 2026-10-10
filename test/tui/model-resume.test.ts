import { expect, test } from "bun:test";

import { runAutomatedTuiScenario } from "./harness/run-scenario.ts";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";
import { modelResumeScenario } from "./scenarios/model-resume.ts";

const loginModelFixture = new URL("../fixtures/tui-login-model.ts", import.meta.url).pathname;

test("TUI restores the last model selected in a resumed session", async () => {
  await runAutomatedTuiScenario(modelResumeScenario);
});

test.each(["glm", "GLM"])("TUI saves the default model after searching for %s and uses it in a new session", async (query) => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-default-model-" });
  const command = [process.execPath, modelResumeScenario.fixture];
  await using session = TerminalSession.start({ command, workspace });
  await session.waitForScreen("initial default model", /◈ scenario\/glm-5\.3(?!-flash)/u);
  await session.sendAndWait("/settings\r", "open settings", /ZCode settings/u);
  await session.sendAndWait("\r", "open default model picker", /Default model/u);
  await session.waitForScreen("unfiltered model", /scenario\/kimi-k3/u);
  await session.sendAndWait(query, "filter default models", new RegExp(`Filter: ${query}`, "u"));
  await session.waitForScreen("matching provider-qualified model", /scenario\/glm-5\.3-flash/u);
  await session.assertScreenExcludes("nonmatching model", /scenario\/kimi-k3/u);
  await session.sendAndWait(
    "\x1b[B\r",
    "save filtered default model",
    /Default model saved: scenario\/glm-5\.3-flash/u
  );
  expect(JSON.parse(await workspace.read(".default-model-state.json"))).toEqual({
    model: "scenario/glm-5.3-flash"
  });
  await session.waitForScreen("settings show saved default", /Saved: scenario\/glm-5\.3-flash/u);
  await session.sendAndWait("\x1b", "close settings", /◈ scenario\/glm-5\.3-flash/u);
  await session.exit();

  await using freshSession = TerminalSession.start({ command, workspace });
  await freshSession.waitForScreen("new session uses saved default", /◈ scenario\/glm-5\.3-flash/u);
  await freshSession.exit();
}, 20_000);

test("TUI moves the session onto the model saved by a runtime login", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-login-model-" });
  await using session = TerminalSession.start({ command: [process.execPath, loginModelFixture], workspace });
  await session.sendAndWait("/login bigmodel-coding-plan\r", "login response", /Configured BigModel Coding Plan/u);
  await session.sendAndWait(
    "check this project\r",
    "prompt uses the login model",
    /Echo from account:bigmodel-individual-coding-plan\/GLM-5\.3: check this project/u
  );
  await session.exit();
}, 20_000);
