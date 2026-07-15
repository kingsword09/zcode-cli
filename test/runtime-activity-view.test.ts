import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { RuntimeActivityView } from "../packages/zcode-tui/src/runtime-activity-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

describe("runtime activity view", () => {
  test("stays absent when there is no persistent activity", () => {
    const view = new RuntimeActivityView(createTheme(false));
    expect(view.render(80)).toEqual([]);
  });

  test("renders active tools, background tasks and prioritized todos in place", () => {
    const view = new RuntimeActivityView(createTheme(false));
    view.update({
      projection: {
        activeToolCalls: [{ toolCallId: "tool-1", toolName: "Bash", status: "running" }],
        backgroundJobs: [{
          taskId: "bg-1",
          status: "running",
          description: "Run repository tests",
          cancellable: true
        }]
      },
      todos: [
        { content: "Later cleanup", status: "pending", priority: "low" },
        { content: "Finish projection bridge", status: "in_progress", priority: "high" },
        { content: "Review errors", status: "pending", priority: "high" }
      ]
    });
    const rendered = view.render(100).join("\n");
    expect(rendered).toContain("Activity · 1 active tool · 1 in background · 3 open tasks · /tasks");
    expect(rendered).toContain("● Bash");
    expect(rendered).toContain("Run repository tests · bg-1");
    expect(rendered.indexOf("Finish projection bridge")).toBeLessThan(rendered.indexOf("Review errors"));
    expect(rendered.indexOf("Review errors")).toBeLessThan(rendered.indexOf("Later cleanup"));
  });

  test("links collapsed overflow to a complete width-safe activity view", () => {
    const state = {
      projection: {
        activeToolCalls: Array.from({ length: 7 }, (_, index) => ({
          toolCallId: `tool-${index + 1}`,
          toolName: `Tool ${index + 1} 👨‍👩‍👧‍👦 with a detailed activity description`,
          status: "running" as const
        })),
        backgroundJobs: []
      },
      todos: Array.from({ length: 6 }, (_, index) => ({
        content: `Open task ${index + 1} 👨‍👩‍👧‍👦 with complete detail`,
        status: "pending" as const,
        priority: "medium" as const
      }))
    };
    const collapsed = new RuntimeActivityView(createTheme(false));
    collapsed.update(state);
    const summary = collapsed.render(80).join("\n");
    expect(summary).toContain("2 more activities · /activity");
    expect(summary).toContain("2 more tasks · /activity");

    const expanded = new RuntimeActivityView(createTheme(false), true);
    expanded.update(state);
    const lines = expanded.render(40);
    expect(lines.join("\n")).toContain("Tool 7");
    expect(lines.join("\n")).toContain("Open task 6");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });
});
