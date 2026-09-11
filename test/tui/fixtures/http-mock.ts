#!/usr/bin/env bun

import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import { createScenarioHttpMock } from "../runtime/scenario-http.ts";
import {
  createScenarioRuntime,
  ScenarioRuntimeJournal
} from "../runtime/scenario-runtime.ts";

const journal = new ScenarioRuntimeJournal(
  process.env.ZCODE_TUI_SCENARIO_RUNTIME_JOURNAL
);
using httpMock = createScenarioHttpMock({
  journal,
  routes: [{
    id: "model-catalog",
    method: "GET",
    url: "https://scenario.invalid/api/models",
    expectedCalls: 1,
    assert(context) {
      if (context.request.headers.get("x-scenario-client") !== "zcode-tui") {
        throw new Error("The model catalog request is missing its scenario client header.");
      }
    },
    response: {
      type: "json",
      body: {
        models: [
          { id: "glm-5", name: "GLM-5 Mock" },
          { id: "glm-4.7", name: "GLM-4.7 Mock" }
        ]
      },
      delayMilliseconds: 20
    }
  }]
});
httpMock.start();

const runtime = createScenarioRuntime({
  journal,
  unmatchedResponse: "Type “fetch mocked catalog” to start.",
  turns: [{
    id: "fetch-model-catalog",
    match: "fetch mocked catalog",
    steps: [{
      type: "respond",
      response: async () => {
        const response = await fetch("https://scenario.invalid/api/models", {
          headers: { "x-scenario-client": "zcode-tui" }
        });
        if (!response.ok) throw new Error(`Mock catalog request failed with ${response.status}.`);
        const payload = await response.json() as {
          models: Array<{ id: string; name: string }>;
        };
        return `Mock catalog: ${payload.models.map((model) => model.name).join(", ")}`;
      }
    }]
  }]
});

await runTui({
  version: "http-mock-scenario",
  workspaceDirectory: process.cwd(),
  initialMode: "build",
  initialModel: "scenario/model",
  modelOptions: [{ alias: "main", id: "scenario/model", name: "Scenario" }],
  loadSessionTranscript: async () => [
    {
      messageId: "scenario_instruction",
      role: "agent",
      content: "Type “fetch mocked catalog” to exercise a real fetch through the strict MSW boundary."
    }
  ],
  submitPrompt: runtime.submitPrompt,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
} as Parameters<typeof runTui>[0]);

httpMock.assertSatisfied();
