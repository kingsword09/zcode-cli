import { expect, test } from "bun:test";

import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { createScenarioRuntime } from "./runtime/scenario-runtime.ts";

test("scenario runtime matches input, writes isolated files, and journals the response", async () => {
  await using workspace = await ScenarioWorkspace.create();
  const runtime = createScenarioRuntime({
    journalPath: workspace.runtimeJournalPath,
    workspaceDirectory: workspace.directory,
    turns: [{
      id: "write",
      match: /^write fixture$/u,
      steps: [{
        type: "writeFiles",
        files: { "nested/result.txt": "fixture result\n" }
      }, {
        type: "respond",
        response: "Write complete.",
        metadata: { sessionId: "scenario-session" }
      }]
    }]
  });

  await expect(runtime.submitPrompt("write fixture", {})).resolves.toEqual({
    response: "Write complete.",
    sessionId: "scenario-session"
  });
  expect(await workspace.read("nested/result.txt")).toBe("fixture result\n");
  expect(runtime.journal.entries().map((entry) => entry.kind)).toEqual([
    "turn.start",
    "step.start",
    "files.write",
    "step.finish",
    "step.start",
    "turn.finish"
  ]);
  expect(await workspace.readRuntimeJournal()).toContain('"kind":"turn.finish"');
});

test("scenario runtime starts parallel permission requests before awaiting either result", async () => {
  const first = Promise.withResolvers<unknown>();
  const second = Promise.withResolvers<unknown>();
  const calls: unknown[] = [];
  const runtime = createScenarioRuntime({
    turns: [{
      id: "permissions",
      match: "run",
      steps: [{
        type: "permissions",
        mode: "parallel",
        requests: [{ id: "first" }, { id: "second" }],
        saveAs: "decisions"
      }, {
        type: "respond",
        response: (context) => context.value<string[]>("decisions").join(",")
      }]
    }]
  });

  const submission = runtime.submitPrompt("run", {
    requestPermission: async (request) => {
      calls.push(request);
      return calls.length === 1 ? await first.promise : await second.promise;
    }
  });
  await Bun.sleep(0);
  expect(calls).toEqual([{ id: "first" }, { id: "second" }]);
  second.resolve("allow-second");
  first.resolve("deny-first");
  await expect(submission).resolves.toEqual({ response: "deny-first,allow-second" });
});

test("scenario runtime keeps sequential permission requests ordered", async () => {
  const first = Promise.withResolvers<unknown>();
  const calls: unknown[] = [];
  const runtime = createScenarioRuntime({
    turns: [{
      id: "permissions",
      match: "run",
      steps: [{
        type: "permissions",
        requests: [{ id: "first" }, { id: "second" }],
        saveAs: "decisions"
      }, {
        type: "respond",
        response: "finished"
      }]
    }]
  });

  const submission = runtime.submitPrompt("run", {
    requestPermission: async (request) => {
      calls.push(request);
      if (calls.length === 1) return await first.promise;
      return "second";
    }
  });
  await Bun.sleep(0);
  expect(calls).toEqual([{ id: "first" }]);
  first.resolve("first");
  await expect(submission).resolves.toEqual({ response: "finished" });
  expect(calls).toEqual([{ id: "first" }, { id: "second" }]);
});

test("scenario runtime emits events and cancels abort-aware delays", async () => {
  const events: unknown[] = [];
  const runtime = createScenarioRuntime({
    turns: [{
      id: "events",
      match: "events",
      steps: [{
        type: "emit",
        event: { type: "fixture.event", payload: { value: 1 } }
      }, {
        type: "respond",
        response: "events complete"
      }]
    }, {
      id: "delay",
      match: "delay",
      steps: [{
        type: "delay",
        milliseconds: 5_000
      }, {
        type: "respond",
        response: "too late"
      }]
    }]
  });

  await runtime.submitPrompt("events", {
    onEvent: (event) => {
      events.push(event);
    }
  });
  expect(events).toEqual([{ type: "fixture.event", payload: { value: 1 } }]);

  const controller = new AbortController();
  const delayed = runtime.submitPrompt("delay", { abortSignal: controller.signal });
  controller.abort(new Error("fixture stopped"));
  await expect(delayed).rejects.toThrow("fixture stopped");
  expect(runtime.journal.entries().at(-1)).toMatchObject({
    kind: "turn.error",
    detail: { error: "fixture stopped", turnId: "delay" }
  });
});

test("scenario runtime rejects unmatched input, unsafe writes, and invalid definitions", async () => {
  const unmatched = createScenarioRuntime({
    turns: [{
      id: "known",
      match: "known",
      steps: [{ type: "respond", response: "known" }]
    }]
  });
  await expect(unmatched.submitPrompt("unknown", {})).rejects.toThrow("No scenario turn matches input");

  const unsafe = createScenarioRuntime({
    workspaceDirectory: process.cwd(),
    turns: [{
      id: "unsafe",
      match: "unsafe",
      steps: [{
        type: "writeFiles",
        files: { "../escaped.txt": "not allowed" }
      }, {
        type: "respond",
        response: "unreachable"
      }]
    }]
  });
  await expect(unsafe.submitPrompt("unsafe", {})).rejects.toThrow("escapes the workspace");

  expect(() => createScenarioRuntime({
    turns: [{
      id: "invalid",
      match: "invalid",
      steps: [{ type: "delay", milliseconds: 1 }]
    }]
  })).toThrow('must end with exactly one respond step');
});

test("scenario runtime covers fallback responses and missing callbacks", async () => {
  const fallback = createScenarioRuntime({
    unmatchedResponse: (context) => `fallback: ${String(context.input)}`,
    turns: [{
      id: "known",
      match: "known",
      steps: [{ type: "respond", response: "known" }]
    }]
  });
  await expect(fallback.submitPrompt("unknown", {})).resolves.toEqual({
    response: "fallback: unknown"
  });

  const missingPermissionCallback = createScenarioRuntime({
    turns: [{
      id: "permissions",
      match: "permissions",
      steps: [{
        type: "permissions",
        requests: [{ id: "permission" }],
        saveAs: "decisions"
      }, {
        type: "respond",
        response: "unreachable"
      }]
    }]
  });
  await expect(missingPermissionCallback.submitPrompt("permissions", {}))
    .rejects.toThrow("permission callback is unavailable");

  expect(() => createScenarioRuntime({
    turns: [{
      id: "invalid-delay",
      match: "invalid-delay",
      steps: [{ type: "delay", milliseconds: -1 }, { type: "respond", response: "never" }]
    }]
  })).toThrow("has an invalid delay");

  expect(() => createScenarioRuntime({
    turns: [{
      id: "duplicate",
      match: "first",
      steps: [{ type: "respond", response: "first" }]
    }, {
      id: "duplicate",
      match: "second",
      steps: [{ type: "respond", response: "second" }]
    }]
  })).toThrow("turn id must be unique");
});

test("scenario runtime rejects pre-aborted turns and writes without a workspace", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already stopped"));
  const runtime = createScenarioRuntime({
    turns: [{
      id: "aborted",
      match: "aborted",
      steps: [{ type: "respond", response: "unreachable" }]
    }]
  });
  await expect(runtime.submitPrompt("aborted", { abortSignal: controller.signal }))
    .rejects.toThrow("already stopped");

  const missingWorkspace = createScenarioRuntime({
    turns: [{
      id: "write",
      match: "write",
      steps: [{
        type: "writeFiles",
        files: { "result.txt": "unreachable" }
      }, {
        type: "respond",
        response: "unreachable"
      }]
    }]
  });
  await expect(missingWorkspace.submitPrompt("write", {}))
    .rejects.toThrow("without a workspaceDirectory");
});
