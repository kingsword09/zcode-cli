import { expect, test } from "bun:test";

import { ScenarioRuntimeJournal } from "./runtime/scenario-runtime.ts";
import { createScenarioHttpMock } from "./runtime/scenario-http.ts";

test("scenario HTTP mock intercepts real fetch calls and validates typed requests", async () => {
  const journal = new ScenarioRuntimeJournal();
  using mock = createScenarioHttpMock({
    journal,
    routes: [{
      id: "update-model",
      method: "POST",
      url: "https://scenario.invalid/api/models/:modelId",
      expectedCalls: 1,
      async assert(context) {
        expect(context.params.modelId).toBe("glm-5");
        expect(await context.json<{ enabled: boolean }>()).toEqual({ enabled: true });
        expect(context.request.headers.get("authorization")).toBe("Bearer fixture-token");
      },
      response: (context) => ({
        type: "json",
        body: {
          call: context.call,
          modelId: context.params.modelId,
          updated: true
        },
        headers: { "x-scenario": "mocked" },
        status: 202
      })
    }]
  });
  mock.start();

  const response = await fetch("https://scenario.invalid/api/models/glm-5", {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({ enabled: true })
  });

  expect(response.status).toBe(202);
  expect(response.headers.get("x-scenario")).toBe("mocked");
  expect(await response.json()).toEqual({ call: 1, modelId: "glm-5", updated: true });
  expect(mock.calls("update-model")).toBe(1);
  mock.assertSatisfied();
  expect(journal.entries().map((entry) => entry.kind)).toEqual([
    "http.start",
    "http.request",
    "http.response",
    "http.assert"
  ]);
  expect(journal.entries()[1]).toMatchObject({
    detail: {
      headers: { authorization: "[redacted]" }
    }
  });
});

test("scenario HTTP mock rejects unhandled requests and records the failure", async () => {
  using mock = createScenarioHttpMock({ routes: [] });
  mock.start();

  expect((await fetch("https://scenario.invalid/unhandled")).status).toBe(500);
  expect(mock.journal.entries().at(-1)).toMatchObject({
    kind: "http.unhandled",
    detail: {
      method: "GET",
      url: "https://scenario.invalid/unhandled"
    }
  });
  expect(() => mock.assertSatisfied()).toThrow(
    "unhandled GET https://scenario.invalid/unhandled"
  );
});

test("scenario HTTP mock reports missing, excess, and unknown route calls", async () => {
  using mock = createScenarioHttpMock({
    routes: [{
      id: "once",
      method: "GET",
      url: "https://scenario.invalid/once",
      expectedCalls: 1,
      response: { type: "empty", status: 204 }
    }]
  });
  mock.start();

  expect(() => mock.assertSatisfied()).toThrow('"once" expected 1, received 0');
  expect(() => mock.calls("missing")).toThrow("Unknown scenario HTTP route");
  expect((await fetch("https://scenario.invalid/once")).status).toBe(204);
  await expect(fetch("https://scenario.invalid/once")).rejects.toThrow();
  expect(() => mock.assertSatisfied()).toThrow('"once" expected 1, received 2');
});

test("scenario HTTP mock supports latency, cancellation, and network errors", async () => {
  using mock = createScenarioHttpMock({
    routes: [{
      id: "delayed",
      method: "GET",
      url: "https://scenario.invalid/delayed",
      response: {
        type: "text",
        body: "too late",
        delayMilliseconds: 5_000
      }
    }, {
      id: "offline",
      method: "GET",
      url: "https://scenario.invalid/offline",
      response: { type: "networkError" }
    }]
  });
  mock.start();

  const controller = new AbortController();
  const delayed = fetch("https://scenario.invalid/delayed", { signal: controller.signal });
  controller.abort(new Error("scenario cancelled"));
  await expect(delayed).rejects.toThrow("scenario cancelled");
  await expect(fetch("https://scenario.invalid/offline")).rejects.toThrow();
  mock.assertSatisfied();
  expect(mock.journal.entries()).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: "http.abort",
      detail: expect.objectContaining({ routeId: "delayed" })
    }),
    expect.objectContaining({
      kind: "http.response",
      detail: expect.objectContaining({ routeId: "offline", type: "networkError" })
    })
  ]));
});

test("scenario HTTP mock rejects ambiguous definitions", () => {
  expect(() => createScenarioHttpMock({
    routes: [{
      id: "duplicate",
      method: "GET",
      url: "https://scenario.invalid/one",
      response: { type: "empty" }
    }, {
      id: "duplicate",
      method: "GET",
      url: "https://scenario.invalid/two",
      response: { type: "empty" }
    }]
  })).toThrow("route id must be unique");

  expect(() => createScenarioHttpMock({
    routes: [{
      id: "invalid-count",
      method: "GET",
      url: "https://scenario.invalid/count",
      expectedCalls: -1,
      response: { type: "empty" }
    }]
  })).toThrow("invalid expectedCalls");
});

test("scenario HTTP mock rejects duplicate starts and allows close before start", () => {
  using mock = createScenarioHttpMock({ routes: [] });

  expect(() => mock.close()).not.toThrow();
  mock.start();
  expect(() => mock.start()).toThrow("already started");
  expect(() => mock.close()).not.toThrow();
  expect(() => mock.close()).not.toThrow();
});

test("scenario HTTP mock records response validation failures", async () => {
  using mock = createScenarioHttpMock({
    routes: [{
      id: "invalid-delay",
      method: "GET",
      url: "https://scenario.invalid/invalid-delay",
      response: {
        type: "text",
        body: "unreachable",
        delayMilliseconds: Number.NaN
      }
    }]
  });
  mock.start();

  await expect(fetch("https://scenario.invalid/invalid-delay")).rejects.toThrow("Failed to fetch");
  expect(mock.journal.entries().at(-1)).toMatchObject({
    kind: "http.error",
    detail: { error: "Scenario HTTP response has an invalid delay: NaN" }
  });
  expect(() => mock.assertSatisfied()).toThrow("invalid delay");
});

test("scenario HTTP mock records route assertion failures", async () => {
  using mock = createScenarioHttpMock({
    routes: [{
      id: "assertion",
      method: "GET",
      url: "https://scenario.invalid/assertion",
      assert() {
        throw new Error("request did not match fixture");
      },
      response: { type: "empty", status: 204 }
    }]
  });
  mock.start();

  await expect(fetch("https://scenario.invalid/assertion")).rejects.toThrow("Failed to fetch");
  expect(mock.journal.entries().at(-1)).toMatchObject({
    kind: "http.error",
    detail: { error: "request did not match fixture" }
  });
  expect(() => mock.assertSatisfied()).toThrow("request did not match fixture");
});

test("scenario HTTP mock truncates request bodies and redacts sensitive headers", async () => {
  const body = "x".repeat(16_385);
  using mock = createScenarioHttpMock({
    routes: [{
      id: "large-request",
      method: "POST",
      url: "https://scenario.invalid/large-request",
      expectedCalls: 1,
      async assert(context) {
        expect((await context.text()).length).toBe(body.length);
      },
      response: {
        type: "text",
        body: "accepted",
        delayMilliseconds: 1
      }
    }]
  });
  mock.start();

  const response = await fetch("https://scenario.invalid/large-request", {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      cookie: "session=secret",
      "x-api-key": "secret"
    },
    body
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("accepted");
  mock.assertSatisfied();

  const requestEntry = mock.journal.entries().find((entry) => entry.kind === "http.request");
  expect(requestEntry).toMatchObject({
    detail: {
      bodyTruncated: true,
      headers: {
        authorization: "[redacted]",
        cookie: "[redacted]",
        "x-api-key": "[redacted]"
      }
    }
  });
  const recordedBody = String((requestEntry?.detail as { body: string }).body);
  expect(recordedBody).toHaveLength(16_385);
  expect(recordedBody.endsWith("…")).toBe(true);
});
