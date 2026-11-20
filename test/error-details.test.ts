import { expect, test } from "bun:test";
import { describeError } from "../packages/zcode-tui/src/error-details.ts";
import { normalizeEvent } from "../packages/zcode-tui/src/events.ts";
import { SystemEventView } from "../packages/zcode-tui/src/system-event-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

test("wrapped failures preserve the cause and diagnostics without dumping request data", () => {
  const cause = Object.assign(new Error("Connection closed by the provider"), {
    code: "ECONNRESET",
    context: { providerId: "fixture", requestId: "request-123", requestHeaders: { authorization: "secret-key" } }
  });
  const error = new Error("Turn execution failed", { cause });
  const details = describeError(error);
  expect(details.message).toBe(cause.message);
  expect(details.detail).toContain("Code: ECONNRESET");
  expect(details.detail).toContain("Request: request-123");
  expect(details.detail).not.toContain("secret-key");
  expect(details.detail).not.toContain("at ");
});

test("projected runtime errors show their cause before expansion and retain full diagnostics", () => {
  const event = normalizeEvent({ method: "session/event", params: {
    type: "turn.failed", payload: { error: {
      message: "Provider rejected the model request.",
      underlyingErrorMessage: "Insufficient account balance",
      detail: "Add credit to this provider account.",
      code: "insufficient_balance",
      attribution: { statusCode: 402, errorPhase: "response", providerId: "fixture" }
    } }
  } })!;
  expect(event.message).toBe("Insufficient account balance");
  const view = new SystemEventView(createTheme(false), {
    tone: "error", title: "Turn failed", detail: event.errorDetail
  });
  expect(view.render(80).join("\n")).toContain("Insufficient account balance");
  expect(view.hasHiddenContent()).toBe(true);
  view.setExpanded(true);
  const expanded = view.render(80).join("\n");
  expect(expanded).toContain("Add credit to this provider account.");
  expect(expanded).toContain("HTTP: 402");
  expect(expanded).toContain("Code: insufficient_balance");
  expect(expanded).toContain("Phase: response");
});

test("short errors are fully visible and long errors remain expandable", () => {
  const short = new SystemEventView(createTheme(false), {
    tone: "error", title: "Turn failed", detail: "Invalid API key"
  });
  expect(short.render(80).join("\n")).toContain("Invalid API key");
  expect(short.hasHiddenContent()).toBe(false);
  expect(short.render(80).join("\n")).not.toContain("Ctrl+O");
  const long = new SystemEventView(createTheme(false), {
    tone: "error", title: "Turn failed", detail: "Provider rejected the request: " + "reason ".repeat(100) + "END_OF_ERROR"
  });
  expect(long.render(80).length).toBeLessThan(8);
  expect(long.hasHiddenContent()).toBe(true);
  long.setExpanded(true);
  expect(long.render(80).join("\n")).toContain("END_OF_ERROR");
});

test("failure extraction tolerates cycles, blank wrappers and terminal escape sequences", () => {
  const error: Record<string, unknown> = {
    message: "  ",
    error: { message: "\x1b]2;UNTRUSTED_TITLE\x07\x1b[31mProvider unavailable\x1b[0m" }
  };
  error.cause = error;
  expect(describeError(error).message).toBe("Provider unavailable");
  expect(describeError({ message: "Turn execution failed" }, { message: "Request timed out" }).message)
    .toBe("Request timed out");
  expect(describeError({ message: "New failure" }, { message: "Previous failure" }).message).toBe("New failure");
});
