import { describe, expect, test } from "bun:test";

import {
  parseSelectionCommand,
  protectSubmission,
  redactSecrets,
  selectionSubmission
} from "../packages/zcode-tui/src/selection-command.ts";

describe("structured selection commands", () => {
  test("preserves upstream masked-input metadata", () => {
    const command = parseSelectionCommand({
      command: "/login zai-coding-plan-api-key",
      id: "zai-coding-plan-api-key",
      primary: "Z.AI Coding Plan API Key",
      secondary: "Paste a key manually.",
      input: {
        cancelStatus: "cancelled",
        emptyStatus: "required",
        help: "Enter saves the key.",
        mask: true,
        placeholder: "Paste API key",
        primary: "Enter Z.AI API Key",
        secondary: "It remains hidden.",
        submitStatus: "Saving API key..."
      }
    }, 0);

    expect(command).toMatchObject({
      command: "/login zai-coding-plan-api-key",
      input: {
        mask: true,
        placeholder: "Paste API key",
        submitStatus: "Saving API key..."
      }
    });
    const submission = selectionSubmission(command!, "  top-secret-key  ");
    expect(submission).toEqual({
      cancelStatus: "cancelled",
      displayInput: "/login zai-coding-plan-api-key [redacted]",
      input: "/login zai-coding-plan-api-key top-secret-key",
      recordHistory: false,
      secrets: ["top-secret-key"],
      status: "Saving API key..."
    });
    expect(selectionSubmission(command!, "   ")).toBeNull();
  });

  test("redacts directly typed API-key commands and downstream errors", () => {
    const submission = protectSubmission("/login bigmodel-coding-plan-api-key private-key");
    expect(submission.recordHistory).toBe(false);
    expect(submission.displayInput).toBe("/login bigmodel-coding-plan-api-key [redacted]");
    expect(redactSecrets("Could not save private-key", submission.secrets)).toBe(
      "Could not save [redacted]"
    );
  });

  test("keeps ordinary selection commands recordable", () => {
    const command = parseSelectionCommand({
      command: "/resume session-1",
      primary: "Session one"
    }, 0);
    expect(selectionSubmission(command!)).toMatchObject({
      displayInput: "/resume session-1",
      recordHistory: true,
      secrets: []
    });
  });

  test("preserves OAuth pending and cancellation status", () => {
    const command = parseSelectionCommand({
      command: "/login zai-coding-plan",
      primary: "Z.AI Coding Plan",
      pending: {
        cancelStatus: "Login cancelled.",
        help: "Esc cancels.",
        primary: "Waiting for authorization",
        secondary: "Complete login in the browser.",
        status: "Waiting for browser authorization..."
      }
    }, 0);
    expect(selectionSubmission(command!)).toMatchObject({
      cancelStatus: "Login cancelled.",
      pending: {
        primary: "Waiting for authorization",
        help: "Esc cancels."
      },
      status: "Waiting for browser authorization..."
    });
  });
});
