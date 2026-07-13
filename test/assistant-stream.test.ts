import { describe, expect, test } from "bun:test";
import { Text } from "@earendil-works/pi-tui";

import { AssistantStream } from "../packages/zcode-tui/src/assistant-stream.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import { Transcript } from "../packages/zcode-tui/src/transcript.ts";

function renderedLines(transcript: Transcript): string[] {
  return transcript.render(80).map((line) => line.trimEnd());
}

describe("TUI assistant stream", () => {
  test("starts a new assistant block after a tool boundary", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream(createTheme(false), (component) => transcript.addBlock(component));

    stream.beginTurn();
    stream.append("I will inspect the repository first.");
    stream.breakSegment();
    transcript.addBlock(new Text("● Read README.md", 1, 0));
    stream.append("The project is ready.");

    const lines = renderedLines(transcript);
    const commentary = lines.findIndex((line) => line.includes("I will inspect"));
    const tool = lines.findIndex((line) => line.includes("● Read"));
    const final = lines.findIndex((line) => line.includes("The project is ready"));
    expect(commentary).toBeGreaterThanOrEqual(0);
    expect(tool).toBeGreaterThan(commentary);
    expect(final).toBeGreaterThan(tool);
  });

  test("does not duplicate an already streamed final response", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream(createTheme(false), (component) => transcript.addBlock(component));

    stream.beginTurn();
    stream.append("Checking files. ");
    stream.breakSegment();
    transcript.addBlock(new Text("✓ Read README.md", 1, 0));
    stream.append("Final result.");
    expect(stream.reconcile("Final result.")).toBe("Final result.");

    expect(renderedLines(transcript).join("\n").match(/Final result\./g)).toHaveLength(1);
  });

  test("places a non-streamed authoritative response after tools", () => {
    const transcript = new Transcript();
    const stream = new AssistantStream(createTheme(false), (component) => transcript.addBlock(component));

    stream.beginTurn();
    stream.append("Checking files.");
    stream.breakSegment();
    transcript.addBlock(new Text("✓ Bash bun test", 1, 0));
    stream.reconcile("Authoritative final response.");

    const lines = renderedLines(transcript);
    const tool = lines.findIndex((line) => line.includes("✓ Bash"));
    const final = lines.findIndex((line) => line.includes("Authoritative final response"));
    expect(final).toBeGreaterThan(tool);
  });
});
