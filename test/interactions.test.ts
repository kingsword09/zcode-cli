import { describe, expect, test } from "bun:test";

import {
  answeredQuestionInput,
  collectUserQuestionAnswers,
  defaultPermissionChoices,
  isAskUserQuestionTool,
  isExitPlanModeTool,
  parseUserQuestions,
  planText
} from "../packages/zcode-tui/src/interactions.ts";

describe("TUI structured interactions", () => {
  test("parses single and multi-select AskUserQuestion inputs", () => {
    expect(parseUserQuestions({
      questions: [{
        question: "Which renderer?",
        header: "Renderer",
        options: [
          { label: "Compact", description: "One line", preview: "```ts\nconst compact = true\n```" },
          { label: "Detailed", description: "Full output" }
        ]
      }, {
        question: "Which extras?",
        header: "Extras",
        multiSelect: true,
        options: [{ label: "Diff" }, { label: "Search" }]
      }]
    })).toEqual([{
      question: "Which renderer?",
      header: "Renderer",
      multiSelect: false,
      options: [
        {
          value: "Compact",
          label: "Compact",
          description: "One line",
          preview: "```ts\nconst compact = true\n```"
        },
        { value: "Detailed", label: "Detailed", description: "Full output", preview: undefined }
      ]
    }, {
      question: "Which extras?",
      header: "Extras",
      multiSelect: true,
      options: [
        { value: "Diff", label: "Diff", description: undefined, preview: undefined },
        { value: "Search", label: "Search", description: undefined, preview: undefined }
      ]
    }]);
  });

  test("preserves question input while adding answers", () => {
    const input = { questions: [{ question: "Mode?", options: [] }], metadata: { source: "tool" } };
    expect(answeredQuestionInput(input, { "Mode?": "Compact" })).toEqual({
      ...input,
      answers: { "Mode?": "Compact" }
    });
  });

  test("collects multi-step answers while allowing backtracking", async () => {
    const questions = parseUserQuestions({
      questions: [{
        question: "Which renderer?",
        options: [{ label: "Compact" }, { label: "Detailed" }]
      }, {
        question: "Which extras?",
        options: [{ label: "Diff" }, { label: "Search" }]
      }]
    });
    const seen: Array<{ index: number; previousAnswer?: string }> = [];
    const responses = [
      { kind: "answer", answer: "Compact" },
      { kind: "back" },
      { kind: "answer", answer: "Detailed" },
      { kind: "answer", answer: "Search" }
    ] as const;

    const answers = await collectUserQuestionAnswers(questions, async (_question, index, _total, previousAnswer) => {
      seen.push({ index, previousAnswer });
      return responses[seen.length - 1] ?? { kind: "cancel" };
    });

    expect(answers).toEqual({
      "Which renderer?": "Detailed",
      "Which extras?": "Search"
    });
    expect(seen).toEqual([
      { index: 0, previousAnswer: undefined },
      { index: 1, previousAnswer: undefined },
      { index: 0, previousAnswer: "Compact" },
      { index: 1, previousAnswer: undefined }
    ]);
  });

  test("builds project-scoped permission updates from tool input", () => {
    const choices = defaultPermissionChoices("Bash", { command: "bun test" });
    expect(choices.map((choice) => choice.value)).toEqual([
      "allow_once",
      "allow_project",
      "deny_feedback",
      "deny"
    ]);
    expect(choices[1]?.response).toEqual({
      decision: "allow",
      permissionUpdates: [{
        behavior: "allow",
        rules: [{ toolName: "Bash", ruleContent: "bun test" }],
        type: "addRules"
      }],
      reason: "Approved for this project"
    });
  });

  test("recognizes question and plan tools and extracts plan Markdown", () => {
    expect(isAskUserQuestionTool("AskUserQuestion")).toBe(true);
    expect(isExitPlanModeTool("ExitPlanModeV2")).toBe(true);
    expect(planText({ plan: "# Implementation\n\n1. Build it" })).toBe("# Implementation\n\n1. Build it");
  });
});
