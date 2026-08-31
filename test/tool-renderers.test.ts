import { describe, expect, test } from "bun:test";

import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import {
  canonicalToolName,
  isAgentDispatchTool,
  officialToolNames
} from "../packages/zcode-tui/src/tool-renderers.ts";
import { ToolExecutionView, toolCard } from "../packages/zcode-tui/src/tool-view.ts";

function expandedCard(options: ConstructorParameters<typeof ToolExecutionView>[1]): string {
  const view = new ToolExecutionView(createTheme(false), options);
  view.setExpanded(true);
  return view.render(100).map((line) => line.trimEnd()).join("\n");
}

describe("official tool renderer registry", () => {
  test("maps every official tool and only declared aliases", () => {
    for (const name of officialToolNames) expect(canonicalToolName(name)).toBe(name);
    expect(canonicalToolName("web_search")).toBe("WebSearch");
    expect(canonicalToolName("KillShell")).toBe("TaskStop");
    expect(canonicalToolName("mcp__docs__lookup")).toBe("MCP");
    expect(canonicalToolName("TaskStop")).toBe("TaskStop");
    expect(isAgentDispatchTool("Agent")).toBeTrue();
    expect(isAgentDispatchTool("Subagent")).toBeTrue();
    expect(isAgentDispatchTool("Task")).toBeTrue();
    expect(isAgentDispatchTool("TaskOutput")).toBeFalse();
    expect(canonicalToolName("TaskCreate")).toBeUndefined();
    expect(canonicalToolName("not-a-real-task-tool")).toBeUndefined();
  });

  test("renders WebFetch metadata and expandable page content", () => {
    const options = {
      name: "WebFetch",
      state: "complete",
      input: { url: "https://example.com", prompt: "Summarize" },
      result: {
        success: true,
        output: {
          finalUrl: "https://example.com/final",
          status: 200,
          statusText: "OK",
          bytes: 2_048,
          durationMs: 1_500,
          cacheHit: false,
          redirects: [{ from: "https://example.com", to: "https://example.com/final", status: 301 }],
          result: "Fetched page summary",
          truncated: false
        }
      }
    };
    const compact = toolCard(options);
    expect(compact).toContain("✓ Fetch https://example.com");
    expect(compact).toContain("Received 2 KB · 200 OK · 1s");
    expect(compact).toContain("Ctrl+O to expand");
    expect(compact).not.toContain("Fetched page summary");
    expect(expandedCard(options)).toContain("Fetched page summary");
  });

  test("renders WebSearch counts, timing, summary and sources", () => {
    const options = {
      name: "web_search",
      state: "complete",
      input: { query: "ZCode release" },
      result: {
        query: "ZCode release",
        results: [
          { title: "ZCode", url: "https://zcode.ai" },
          { title: "Docs", url: "https://docs.zcode.ai", pageAge: "2 days" }
        ],
        sources: [{ title: "ZCode", url: "https://zcode.ai" }],
        summary: "Two relevant results.",
        durationMs: 240,
        webSearchRequests: 1
      }
    };
    expect(toolCard(options)).toContain("2 results · 1 source · 1 search · 240ms");
    const expanded = expandedCard(options);
    expect(expanded).toContain("Two relevant results.");
    expect(expanded).toContain("Docs · https://docs.zcode.ai · 2 days");
  });

  test("renders TodoRead and GoalRead without generic JSON", () => {
    const todo = toolCard({
      name: "TodoRead",
      state: "complete",
      result: { todos: [
        { content: "Inspect protocol", status: "completed", priority: "high" },
        { content: "Render tools", status: "in_progress", priority: "high" },
        { content: "Run smoke", status: "pending", priority: "medium" }
      ] }
    });
    expect(todo).toContain("1 completed · 1 in progress · 1 pending");
    expect(todo).toContain("✓ Inspect protocol");
    expect(todo).not.toContain('"todos"');

    const goalOptions = {
      name: "GoalRead",
      state: "complete",
      result: {
        objective: "Implement the complete TUI",
        status: "active",
        tokensUsed: 12_000,
        tokenBudget: 50_000,
        timeUsedSeconds: 90
      }
    };
    const goal = toolCard(goalOptions);
    expect(goal).toContain("✓ Goal Implement the complete TUI");
    expect(goal).toContain("active · 12,000 tokens used · 50,000 budget · 1m 30s");
    expect(goal).not.toContain('"objective"');
  });

  test("renders restored session context as bounded expandable content", () => {
    const options = {
      name: "ReadSessionContext",
      state: "complete",
      input: { sessionId: "sess_previous", query: "renderer decisions", strategy: "relevant" },
      result: {
        status: "success",
        sessionId: "sess_previous",
        strategy: "relevant",
        source: "local",
        content: "Use the official part event stream.",
        messageCount: 40,
        selectedMessageCount: 4,
        truncated: false
      }
    };
    expect(toolCard(options)).toContain("success · local source · 4/40 messages");
    expect(toolCard(options)).not.toContain("Use the official part event stream.");
    expect(expandedCard(options)).toContain("Use the official part event stream.");
  });

  test("renders answered questions and suppresses the input payload", () => {
    const card = toolCard({
      name: "AskUserQuestion",
      state: "complete",
      input: { questions: [{ question: "Which runtime?", header: "Runtime", options: [], multiSelect: false }] },
      result: { questions: [], answers: { "Which runtime?": "Bun" } }
    });
    expect(card).toContain("✓ Question 1 question");
    expect(card).toContain("Which runtime?");
    expect(card).toContain("Bun");
    expect(card).not.toContain('"questions"');
  });

  test("renders complete custom answers retained in the modified question input", () => {
    const answer = "Use the existing terminal editor so a deliberately long custom response wraps naturally and remains visible through this final marker: ANSWER_END";
    const card = toolCard({
      name: "AskUserQuestion",
      state: "complete",
      input: {
        questions: [{ question: "How should this be handled?", header: "Approach", options: [], multiSelect: false }],
        answers: { "How should this be handled?": answer }
      },
      result: { success: true }
    });

    expect(card).toContain("How should this be handled?");
    expect(card).toContain(answer);
    expect(card).toContain("ANSWER_END");
    expect(card).not.toContain('"answers"');
  });

  test("renders SendMessage and TaskStop as distinct tools", () => {
    const message = toolCard({
      name: "SendMessage",
      state: "complete",
      input: { to: "agent_123", summary: "Review renderer", message: "Check the new registry." },
      result: { status: "success", messageId: "msg_1", agentId: "agent_123", delivery: "queued" }
    });
    expect(message).toContain("✓ Message to agent_123 · Review renderer");
    expect(message).toContain("success · queued · id msg_1");

    const stopped = toolCard({
      name: "TaskStop",
      state: "complete",
      input: { task_id: "bg_1" },
      result: { task_id: "bg_1", task_type: "shell", command: "bun test", message: "Successfully stopped" }
    });
    expect(stopped).toContain("✓ Stop task bg_1 · shell");
    expect(stopped).toContain("bun test · stopped");
    expect(stopped).not.toContain("Agent");
  });

  test("maps TaskOutput and renders only the compact runtime display", () => {
    expect(canonicalToolName("TaskOutput")).toBe("TaskOutput");
    expect(canonicalToolName("task_output")).toBe("TaskOutput");

    const transcript = Array.from({ length: 40 }, (_, index) => `tool_use ${index}: Bash → ls -la /src`).join("\n");
    const display = {
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "completed",
      output: "Subagent final answer: renderer fixed.",
      truncated: true
    };

    const live = toolCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_1" },
      result: {
        success: true,
        content: `<retrieval_status>success</retrieval_status>\n<output>\n${transcript}\n</output>`,
        display
      }
    });
    expect(live).toContain("✓ TaskOutput task bg_1");
    expect(live).toContain("retrieved · completed · output truncated");
    expect(live).toContain("Subagent final answer: renderer fixed.");
    expect(live).not.toContain("tool_use 0");
    expect(live).not.toContain('"success"');

    const restored = toolCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_1" },
      result: {
        output: `<retrieval_status>success</retrieval_status>\n<task_id>bg_1</task_id>\n<output>\n${transcript}\n</output>`,
        display
      }
    });
    expect(restored).toContain("Subagent final answer: renderer fixed.");
    expect(restored).not.toContain("tool_use 0");
  });

  test("renders TaskOutput from persisted fallbacks without display metadata", () => {
    const serialized = JSON.stringify({
      retrieval_status: "success",
      task: {
        task_id: "bg_2",
        task_type: "local_agent",
        status: "failed",
        output: "Agent failed: boom",
        error: "boom"
      }
    });
    const serializedCard = toolCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_2" },
      result: { output: serialized }
    });
    expect(serializedCard).toContain("✓ TaskOutput task bg_2");
    expect(serializedCard).toContain("failed");
    expect(serializedCard).toContain("Task output is available in /tasks.");
    expect(serializedCard).not.toContain("Agent failed: boom");
    expect(serializedCard).not.toContain('"retrieval_status"');

    const modelContent = "<retrieval_status>timeout</retrieval_status>\n<output>\npartial transcript tail\n</output>";
    const timeoutCard = toolCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_3" },
      result: { output: modelContent }
    });
    expect(timeoutCard).toContain("timed out waiting");
    expect(timeoutCard).toContain("No output yet");
    expect(timeoutCard).not.toContain("partial transcript tail");

    const notReady = toolCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_4" },
      result: {
        success: true,
        content: "<retrieval_status>not_ready</retrieval_status>",
        display: { kind: "task_output", retrievalStatus: "not_ready" }
      }
    });
    expect(notReady).toContain("not ready yet");
    expect(notReady).toContain("No output yet");
  });

  test("renders TaskOutput when the restored part passes the raw output string through", () => {
    // upsertProtocolPart builds result = part.output (a bare string) when the
    // persisted part carries no resultDisplay metadata at all. There is no
    // compact display left to recover, so the renderer consumes the string and
    // keeps the raw output in /tasks instead of making it expandable here.
    const transcript = Array.from({ length: 30 }, (_, index) => `tool_use ${index}: Bash → ls /src`).join("\n");
    const modelContent = `<retrieval_status>success</retrieval_status>\n<task_id>bg_5</task_id>\n<output>\n${transcript}\n</output>`;
    const card = toolCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_5" },
      result: modelContent
    });
    expect(card).toContain("✓ TaskOutput task bg_5");
    expect(card).toContain("retrieved");
    expect(card).toContain("Task output is available in /tasks.");
    expect(card).not.toContain("tool_use 0");
    expect(card).not.toContain("<retrieval_status>");
    expect(card).not.toContain("<task_id>");
    expect(card).not.toContain("</output>");
    expect(expandedCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_5" },
      result: modelContent
    })).not.toContain("tool_use 29");

    const liveWithoutDisplay = toolCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_5" },
      result: { success: true, content: modelContent }
    });
    expect(liveWithoutDisplay).toContain("retrieved");
    expect(liveWithoutDisplay).not.toContain("tool_use 0");
    expect(liveWithoutDisplay).not.toContain('"content"');

    const serialized = JSON.stringify({
      retrieval_status: "timeout",
      task: null
    });
    const timeoutCard = toolCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_6" },
      result: serialized
    });
    expect(timeoutCard).toContain("timed out waiting");
    expect(timeoutCard).toContain("No output yet");
    expect(timeoutCard).not.toContain('"retrieval_status"');
  });

  test("preserves serialized TaskOutput failures from restored parts", () => {
    const failure = JSON.stringify({
      result: false,
      errorCode: 2,
      message: "No task found with ID: bg_missing"
    });
    for (const result of [failure, { output: failure }]) {
      const card = toolCard({
        name: "TaskOutput",
        state: "complete",
        input: { task_id: "bg_missing" },
        result
      });
      expect(card).toContain("No task found with ID: bg_missing");
      expect(card).not.toContain("Task output is available in /tasks.");
      expect(card).not.toContain('"errorCode"');
    }
  });

  test("keeps terminal control sequences out of every TaskOutput path", () => {
    const injection = `<retrieval_status>success</retrieval_status>\n<output>\nprefix \x1b]52;c;aGVsbG8=\x1b\\ suffix\n</output>`;
    const fallbackCard = toolCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_7" },
      result: injection
    });
    expect(fallbackCard).toContain("retrieved");
    expect(fallbackCard).not.toContain("prefix");
    expect(fallbackCard).not.toContain("suffix");
    expect(fallbackCard).not.toContain("\x1b");

    const displayCard = toolCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_7" },
      result: {
        display: {
          kind: "task_output",
          retrievalStatus: "success",
          output: "prefix \x1b]52;c;aGVsbG8=\x1b\\ suffix"
        }
      }
    });
    expect(displayCard).toContain("prefix");
    expect(displayCard).toContain("suffix");
    expect(displayCard).not.toContain("\x1b]52");
    expect(displayCard).not.toContain("\x1b");
  });

  test("hard-bounds trusted TaskOutput display metadata", () => {
    const card = expandedCard({
      name: "TaskOutput",
      state: "complete",
      input: { task_id: "bg_8" },
      result: {
        display: {
          kind: "task_output",
          retrievalStatus: "success",
          output: `${"x".repeat(2_500)}END`
        }
      }
    });
    expect(card).toContain("output truncated");
    expect(card).not.toContain("END");
    expect(card.length).toBeLessThan(2_200);
  });

  test("renders Agent content arrays and background launch metadata", () => {
    const completed = {
      name: "Agent",
      state: "complete",
      input: { description: "Inspect renderer", prompt: "Review the TUI" },
      result: {
        status: "completed",
        agentId: "agent_1",
        content: [{ type: "text", text: "Renderer review complete." }],
        totalToolUseCount: 3,
        totalDurationMs: 5_000,
        totalTokens: 1_200
      }
    };
    const compact = toolCard(completed);
    expect(compact).toContain("completed · 3 tool uses · 1,200 tokens · 5s");
    expect(compact).not.toContain("Renderer review complete.");
    const expanded = expandedCard(completed);
    expect(expanded).toMatch(/Prompt:\s*Review the TUI/u);
    expect(expanded).toMatch(/Response:\s*Renderer review complete\./u);

    const background = toolCard({
      name: "Task",
      state: "complete",
      input: { description: "Run audit", prompt: "Audit the app", run_in_background: true },
      result: {
        status: "async_launched",
        agentId: "agent_2",
        childSessionId: "sess_child",
        backgroundTaskId: "bg_2",
        outputFile: "/tmp/agent.out"
      }
    });
    expect(background).toContain("✓ Task Run audit");
    expect(background).toContain("background task bg_2");
    expect(background).toContain("output /tmp/agent.out");
  });

  test("renders Skill and dynamic MCP results with bounded detail", () => {
    const skillOptions = {
      name: "Skill",
      state: "complete",
      input: { skill: "review" },
      result: { name: "review", content: "# Review instructions", baseDirectory: "/skills/review", truncated: false }
    };
    expect(toolCard(skillOptions)).toContain("Loaded · /skills/review");
    expect(toolCard(skillOptions)).not.toContain("# Review instructions");
    expect(expandedCard(skillOptions)).toContain("# Review instructions");

    const mcp = toolCard({
      name: "mcp__docs__lookup",
      state: "complete",
      input: { query: "Bun.Terminal" },
      result: { title: "Terminal API", url: "https://bun.sh/docs/api/terminal", count: 2 }
    });
    expect(mcp).toContain("✓ MCP · docs/lookup query=Bun.Terminal");
    expect(mcp).toContain("title: Terminal API");
    expect(mcp).not.toContain('"title"');
  });
});
