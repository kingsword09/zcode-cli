import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  isPlanUpdateTool,
  planCard,
  PlanUpdateView
} from "../packages/zcode-tui/src/plan-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import { ToolExecutionView } from "../packages/zcode-tui/src/tool-view.ts";

const todos = [
  { content: "映射官方生命周期事件", status: "completed", priority: "high" },
  { content: "渲染计划更新", status: "in_progress", priority: "high" },
  { content: "同步本地 runtime", status: "pending", priority: "medium" }
];

describe("TUI plan update view", () => {
  test("renders official TodoWrite items as a compact checklist", () => {
    const card = planCard({ state: "complete", input: { todos } });

    expect(card).toContain("● Updated Plan");
    expect(card).toContain("└ 1 completed · 1 in progress · 1 pending");
    expect(card).toContain("✓ 映射官方生命周期事件");
    expect(card).toContain("□ 渲染计划更新");
    expect(card).toContain("□ 同步本地 runtime");
    expect(card).not.toContain("priority");
    expect(card).not.toContain("TodoWrite");
  });

  test("shows live and failed plan update states", () => {
    expect(planCard({ state: "running", input: { todos } })).toContain("● Updating Plan · running");
    expect(planCard({ state: "failed", input: { todos }, error: { message: "Todo storage failed" } }))
      .toContain("✗ Plan update failed");
    expect(planCard({ state: "failed", input: { todos }, error: { message: "Todo storage failed" } }))
      .toContain("Todo storage failed");
  });

  test("prefers authoritative result todos and stays within narrow terminals", () => {
    const view = new PlanUpdateView(createTheme(false), {
      state: "complete",
      input: { todos },
      result: {
        output: {
          todos: todos.map((todo) => ({ ...todo, status: "completed" }))
        }
      }
    });
    const lines = view.render(32);

    expect(lines.join("\n")).toContain("3 completed · 0 in progress");
    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
  });

  test("integrates with the existing tool card without raw JSON", () => {
    const view = new ToolExecutionView(createTheme(false), {
      name: "TodoWrite",
      state: "running",
      inputText: JSON.stringify({ todos })
    });
    const output = view.render(72).map((line) => line.trimEnd()).join("\n");

    expect(isPlanUpdateTool("TodoWrite")).toBe(true);
    expect(output).toContain("Updating Plan");
    expect(output).toContain("渲染计划更新");
    expect(output).not.toContain('"todos"');
  });
});
