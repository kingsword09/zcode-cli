import { describe, expect, test } from "bun:test";

import {
  formatWorkflowPanel,
  isMcpPickerRequest,
  isTerminalWorkflowStatus,
  mcpPicker,
  workflowRunPicker
} from "../packages/zcode-tui/src/panels.ts";

describe("TUI operational panels", () => {
  test("turns MCP status entries into connect and disconnect actions", () => {
    const picker = mcpPicker({
      alpha: { status: "connected", toolCount: 2, transport: "stdio" },
      beta: { status: "disconnected", toolCount: 0, transport: "http", error: "offline" }
    });

    expect(picker.items.map((item) => item.command)).toEqual([
      "/mcp disconnect alpha",
      "/mcp connect beta"
    ]);
    expect(picker.items[1]?.description).toContain("offline");
    expect(isMcpPickerRequest("/mcp status")).toBe(true);
    expect(isMcpPickerRequest("/mcp connect alpha")).toBe(false);
  });

  test("builds workflow run choices and a bounded detail projection", () => {
    const panel = {
      title: "/workflows",
      selectedRunId: "run-2",
      runs: [
        { runId: "run-1", status: "completed", task: "First" },
        { runId: "run-2", status: "running", task: "Second", kind: "script" }
      ],
      detail: {
        snapshot: { runId: "run-2", status: "running", task: "Second", updatedAt: "2026-07-13T10:00:00Z" },
        scheduler: { active: 2, completed: 3, total: 5 },
        events: [
          { timestamp: "2026-07-13T10:00:00Z", type: "phase.started", status: "running" }
        ]
      }
    };
    const picker = workflowRunPicker(panel);
    const text = formatWorkflowPanel(panel);

    expect(picker.selectedIndex).toBe(1);
    expect(picker.items[1]?.command).toBe("run-2");
    expect(text).toContain("**Second**");
    expect(text).toContain("Status: running");
    expect(text).toContain("active: 2");
    expect(text).toContain("phase.started");
    expect(isTerminalWorkflowStatus("completed")).toBe(true);
    expect(isTerminalWorkflowStatus("running")).toBe(false);
  });
});
