import { describe, expect, test } from "bun:test";

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
});
