import { test } from "bun:test";

import { runAutomatedTuiScenario } from "./harness/run-scenario.ts";
import { modelResumeScenario } from "./scenarios/model-resume.ts";

test("TUI restores the last model selected in a resumed session", async () => {
  await runAutomatedTuiScenario(modelResumeScenario);
});
