#!/usr/bin/env bun

import { Markdown, type Component } from "@earendil-works/pi-tui";

import { AssistantStream } from "../packages/zcode-tui/src/assistant-stream.ts";
import { BoundedToolText } from "../packages/zcode-tui/src/bounded-tool-text.ts";
import { CodeHighlighter } from "../packages/zcode-tui/src/code-highlighter.ts";
import { RichMarkdown } from "../packages/zcode-tui/src/rich-markdown.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

interface StreamBenchmarkSample {
  ingestCpuMs: number;
  ingestWallMs: number;
  renderWallMs: number;
}

interface FrameBenchmark {
  first100AverageMs: number;
  last100AverageMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

interface SourceFrameBenchmark extends FrameBenchmark {
  sourceCharacters: number;
}

interface ToolTextBenchmarkSample {
  appendCpuMs: number;
  appendWallMs: number;
  materializeWallMs: number;
  outputCharacters: number;
  retainedCharacters: number;
}

const deltaCount = 10_000;
const activeToolDeltaCount = 100_000;
const sampleCount = 5;

type BenchmarkScenario =
  | "bash-fence"
  | "javascript-fence"
  | "javascript-function-fence"
  | "javascript-nested-function-fence"
  | "json-fence"
  | "nested-json-fence"
  | "loose-ordered-list"
  | "loose-quoted-list"
  | "python-fence"
  | "python-f-string-fence"
  | "quoted-typescript-fence"
  | "typescript-function-fence"
  | "depth-two-typescript-fence"
  | "deep-typescript-fence"
  | "quoted-python-fence";

type BenchmarkRequest =
  | { kind: "all" }
  | { kind: "scenario"; scenario: BenchmarkScenario }
  | { kind: "verify" };

interface NamedFrameBenchmark extends FrameBenchmark {
  name: string;
  sourceCharacters?: number;
}

function requestedBenchmark(): BenchmarkRequest {
  const args = process.argv.slice(2);
  if (args.length === 0) return { kind: "all" };
  if (args.length === 1 && args[0] === "--verify") return { kind: "verify" };
  if (args.length !== 2 || args[0] !== "--scenario") {
    throw new Error(
      "Usage: bench-tui-stream.ts [--verify | --scenario bash-fence|javascript-fence|javascript-function-fence|javascript-nested-function-fence|json-fence|nested-json-fence|loose-ordered-list|loose-quoted-list|python-fence|python-f-string-fence|quoted-typescript-fence|typescript-function-fence|depth-two-typescript-fence|deep-typescript-fence|quoted-python-fence]"
    );
  }
  if (args[1] !== "bash-fence"
    && args[1] !== "javascript-fence"
    && args[1] !== "javascript-function-fence"
    && args[1] !== "javascript-nested-function-fence"
    && args[1] !== "json-fence"
    && args[1] !== "nested-json-fence"
    && args[1] !== "loose-ordered-list"
    && args[1] !== "loose-quoted-list"
    && args[1] !== "python-fence"
    && args[1] !== "python-f-string-fence"
    && args[1] !== "quoted-typescript-fence"
    && args[1] !== "typescript-function-fence"
    && args[1] !== "depth-two-typescript-fence"
    && args[1] !== "deep-typescript-fence"
    && args[1] !== "quoted-python-fence") {
    throw new Error(`Unknown TUI stream benchmark scenario: ${args[1]}`);
  }
  return { kind: "scenario", scenario: args[1] };
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted: number[], value: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;
}

function frameStatistics(times: number[]): FrameBenchmark {
  const sorted = [...times].sort((left, right) => left - right);
  return {
    first100AverageMs: rounded(average(times.slice(0, 100))),
    last100AverageMs: rounded(average(times.slice(-100))),
    maxMs: rounded(Math.max(...times)),
    p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    p99Ms: rounded(percentile(sorted, 0.99))
  };
}

function frameBenchmark(initialText = ""): FrameBenchmark {
  const view = new RichMarkdown(initialText, 1, createTheme(false));
  const times: number[] = [];
  for (let frame = 0; frame < 1_000; frame += 1) {
    for (let token = 0; token < 10; token += 1) view.appendText(" token");
    const startedAt = performance.now();
    view.render(100);
    times.push(performance.now() - startedAt);
  }
  return frameStatistics(times);
}

interface RootListFrameOptions {
  continuation?: boolean;
  incremental?: boolean;
  looseNested?: boolean;
  nested?: boolean;
  nestedContinuation?: boolean;
  ordered?: boolean;
  orderedContinuation?: boolean;
  orderedNested?: boolean;
  looseOrdered?: boolean;
}

function listFrameBenchmark(
  colorsEnabled = true,
  options: RootListFrameOptions = {}
): SourceFrameBenchmark {
  const theme = createTheme(colorsEnabled);
  const incremental = options.incremental ?? true;
  const optimized = incremental ? new RichMarkdown("", 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown("", 1, 0, theme.markdown);
  const times: number[] = [];
  let source = "";
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let item = 0; item < 3; item += 1) {
      const index = frame * 3 + item;
      if (options.looseNested) {
        delta += `- parent ${index} with **bold** output\n\n`;
        delta += `  - child ${index} with generated words\n\n`;
        continue;
      }
      if (options.looseOrdered) {
        delta += `${index + 1}. item ${index} with **bold** generated output\n\n`;
        continue;
      }
      if (options.orderedContinuation) {
        delta += `${index + 1}. item ${index} with **bold** generated content\n`;
        delta += `    continuation ${index} with more generated words\n`;
        continue;
      }
      if (options.orderedNested) {
        const marker = `${index + 1}.`;
        delta += `${marker} parent ${index} with **bold** output\n`;
        delta += `${" ".repeat(marker.length + 1)}- child ${index} with generated words\n`;
        continue;
      }
      if (options.continuation) {
        delta += `- item ${index} with **bold** generated content\n`;
        delta += `  continuation ${index} with \`code\` generated details\n`;
        continue;
      }
      if (options.nested) {
        if (options.nestedContinuation) {
          delta += `- parent ${index} **bold** generated\n`;
          delta += `  - child ${index} \`code\` output\n`;
          delta += `    continuation ${index} more words\n`;
        } else {
          delta += `- parent item ${index} with **bold** generated content\n`;
          delta += `  - nested child ${index} with \`code\` generated output\n`;
        }
        continue;
      }
      const marker = options.ordered ? `${index + 1}.` : "-";
      delta += `${marker} item ${index} with **bold** generated content\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function tableFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true
): SourceFrameBenchmark {
  const theme = createTheme(colorsEnabled);
  const opening = "| Index | Value | Result |\n| ---: | :--- | :--- |\n";
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let row = 0; row < 3; row += 1) {
      const index = frame * 3 + row;
      delta += `| ${index} | **value ${index}** | generated output |\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function blockquoteFrameBenchmark(
  colorsEnabled: boolean,
  incremental: boolean
): SourceFrameBenchmark {
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown("", 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown("", 1, 0, theme.markdown);
  const times: number[] = [];
  let source = "";
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      delta += `> quote ${index} with generated stream output\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function nestedBlockquoteFrameBenchmark(
  kind: "bold" | "plain",
  colorsEnabled: boolean,
  incremental = true,
  depth: 2 | 3 | 4 = 2
): SourceFrameBenchmark {
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown("", 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown("", 1, 0, theme.markdown);
  const times: number[] = [];
  let source = "";
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      const content = depth === 4
        ? `quoted depth four ${index} with **bold** generated output`
        : depth === 3
          ? `quoted depth three ${index} with **bold** generated output`
        : kind === "bold"
          ? `**quote ${index}** with generated stream output`
          : `quote ${index} with generated stream output`;
      delta += `${"> ".repeat(depth)}${content}\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function semanticBlockquoteFrameBenchmark(
  kind: "bold" | "code" | "italic" | "link",
  colorsEnabled: boolean
): SourceFrameBenchmark {
  const view = new RichMarkdown("", 1, createTheme(colorsEnabled));
  const times: number[] = [];
  let sourceCharacters = 0;
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      const content = kind === "bold"
        ? `**quote ${index}** with generated stream output`
        : kind === "code"
          ? `\`quote ${index}\` with generated stream output`
          : kind === "italic"
            ? `*quote ${index}* with generated stream output`
            : `[quote ${index}](https://example.com/${index}) with stream output`;
      delta += `> ${content}\n`;
    }
    sourceCharacters += delta.length;
    view.appendText(delta);
    const startedAt = performance.now();
    view.render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters,
    ...frameStatistics(times)
  };
}

interface QuotedListFrameOptions {
  continuation?: boolean;
  depth?: 1 | 2 | 3;
  incremental?: boolean;
  loose?: boolean;
  ordered?: boolean;
}

function quotedListFrameBenchmark(
  colorsEnabled: boolean,
  options: QuotedListFrameOptions = {}
): SourceFrameBenchmark {
  const theme = createTheme(colorsEnabled);
  const incremental = options.incremental ?? true;
  const optimized = incremental ? new RichMarkdown("", 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown("", 1, 0, theme.markdown);
  const times: number[] = [];
  let source = "";
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      const marker = options.ordered ? `${index + 1}.` : "-";
      const quote = "> ".repeat(options.depth ?? 1).trimEnd();
      delta += `${quote} ${marker} item ${index} with **bold** generated output\n`;
      if (options.loose) delta += ">\n";
      if (options.continuation) {
        delta += `>   continuation ${index} with more generated words\n`;
      }
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function looseQuotedListFrameBenchmarks(): Record<string, SourceFrameBenchmark> {
  return {
    colors: quotedListFrameBenchmark(true, { loose: true }),
    colorsFullFallback: quotedListFrameBenchmark(true, { incremental: false, loose: true }),
    noColors: quotedListFrameBenchmark(false, { loose: true }),
    noColorsFullFallback: quotedListFrameBenchmark(false, {
      incremental: false,
      loose: true
    })
  };
}

function looseOrderedListFrameBenchmarks(): Record<string, SourceFrameBenchmark> {
  return {
    colors: listFrameBenchmark(true, { looseOrdered: true }),
    colorsFullFallback: listFrameBenchmark(true, { incremental: false, looseOrdered: true }),
    noColors: listFrameBenchmark(false, { looseOrdered: true }),
    noColorsFullFallback: listFrameBenchmark(false, {
      incremental: false,
      looseOrdered: true
    })
  };
}

function pythonFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true
): SourceFrameBenchmark {
  const opening = "```python\n";
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      delta += `value_${index}: int = ${index}  # generated output\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function pythonFenceFrameBenchmarks(): Record<string, SourceFrameBenchmark> {
  return {
    colors: pythonFenceFrameBenchmark(true),
    colorsFullFallback: pythonFenceFrameBenchmark(true, false),
    noColors: pythonFenceFrameBenchmark(false),
    noColorsFullFallback: pythonFenceFrameBenchmark(false, false)
  };
}

function pythonFStringFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true,
  quoted = false
): SourceFrameBenchmark {
  const sourcePrefix = quoted ? "> " : "";
  const opening = `${sourcePrefix}\`\`\`python\n`;
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      delta += `${sourcePrefix}value_${index} = f"generated {${index}}"  # output\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function pythonFStringFenceFrameBenchmarks(): Record<string, unknown> {
  const atLocation = (quoted: boolean): Record<string, SourceFrameBenchmark> => ({
    colors: pythonFStringFenceFrameBenchmark(true, true, quoted),
    colorsFullFallback: pythonFStringFenceFrameBenchmark(true, false, quoted),
    noColors: pythonFStringFenceFrameBenchmark(false, true, quoted),
    noColorsFullFallback: pythonFStringFenceFrameBenchmark(false, false, quoted)
  });
  return { quoted: atLocation(true), root: atLocation(false) };
}

function jsonFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true,
  quoted = false
): SourceFrameBenchmark {
  const sourcePrefix = quoted ? "> " : "";
  const opening = `${sourcePrefix}\`\`\`json\n${sourcePrefix}{\n`;
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      delta += `${sourcePrefix}  "value_${index}": {"index": ${index}, "active": true},\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function jsonFenceFrameBenchmarks(): Record<string, unknown> {
  const atLocation = (quoted: boolean): Record<string, SourceFrameBenchmark> => ({
    colors: jsonFenceFrameBenchmark(true, true, quoted),
    colorsFullFallback: jsonFenceFrameBenchmark(true, false, quoted),
    noColors: jsonFenceFrameBenchmark(false, true, quoted),
    noColorsFullFallback: jsonFenceFrameBenchmark(false, false, quoted)
  });
  return { quoted: atLocation(true), root: atLocation(false) };
}

function nestedJsonFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true,
  quoted = false
): SourceFrameBenchmark {
  const sourcePrefix = quoted ? "> " : "";
  const opening = `${sourcePrefix}\`\`\`json\n${sourcePrefix}{\n`;
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    const delta = [
      `${sourcePrefix}  "value_${frame}": {`,
      `${sourcePrefix}    "index": ${frame}, "active": true,`,
      `${sourcePrefix}  },`
    ].join("\n") + "\n";
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function nestedJsonFenceFrameBenchmarks(): Record<string, unknown> {
  const atLocation = (quoted: boolean): Record<string, SourceFrameBenchmark> => ({
    colors: nestedJsonFenceFrameBenchmark(true, true, quoted),
    colorsFullFallback: nestedJsonFenceFrameBenchmark(true, false, quoted),
    noColors: nestedJsonFenceFrameBenchmark(false, true, quoted),
    noColorsFullFallback: nestedJsonFenceFrameBenchmark(false, false, quoted)
  });
  return { quoted: atLocation(true), root: atLocation(false) };
}

function bashFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true,
  quoted = false
): SourceFrameBenchmark {
  const sourcePrefix = quoted ? "> " : "";
  const opening = `${sourcePrefix}\`\`\`bash\n`;
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      delta += `${sourcePrefix}echo "generated value_${index}" # output\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function bashFenceFrameBenchmarks(): Record<string, unknown> {
  const atLocation = (quoted: boolean): Record<string, SourceFrameBenchmark> => ({
    colors: bashFenceFrameBenchmark(true, true, quoted),
    colorsFullFallback: bashFenceFrameBenchmark(true, false, quoted),
    noColors: bashFenceFrameBenchmark(false, true, quoted),
    noColorsFullFallback: bashFenceFrameBenchmark(false, false, quoted)
  });
  return { quoted: atLocation(true), root: atLocation(false) };
}

function quotedPythonFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true
): SourceFrameBenchmark {
  const opening = "> ```python\n";
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      delta += `> value_${index}: int = ${index}  # generated output\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function quotedPythonFenceFrameBenchmarks(): Record<string, SourceFrameBenchmark> {
  return {
    colors: quotedPythonFenceFrameBenchmark(true),
    colorsFullFallback: quotedPythonFenceFrameBenchmark(true, false),
    noColors: quotedPythonFenceFrameBenchmark(false),
    noColorsFullFallback: quotedPythonFenceFrameBenchmark(false, false)
  };
}

function javascriptFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true,
  quoted = false
): SourceFrameBenchmark {
  const sourcePrefix = quoted ? "> " : "";
  const opening = `${sourcePrefix}\`\`\`javascript\n`;
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      delta += `${sourcePrefix}const value_${index} = ${index}; // generated output\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function javascriptFenceFrameBenchmarks(): Record<string, unknown> {
  const atLocation = (quoted: boolean): Record<string, SourceFrameBenchmark> => ({
    colors: javascriptFenceFrameBenchmark(true, true, quoted),
    colorsFullFallback: javascriptFenceFrameBenchmark(true, false, quoted),
    noColors: javascriptFenceFrameBenchmark(false, true, quoted),
    noColorsFullFallback: javascriptFenceFrameBenchmark(false, false, quoted)
  });
  return { quoted: atLocation(true), root: atLocation(false) };
}

function javascriptFunctionFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true,
  quoted = false
): SourceFrameBenchmark {
  const sourcePrefix = quoted ? "> " : "";
  const opening = `${sourcePrefix}\`\`\`javascript\n`;
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    const delta = [
      `${sourcePrefix}function generated_${frame}(input) {`,
      `${sourcePrefix}  return input + ${frame};`,
      `${sourcePrefix}}`
    ].join("\n") + "\n";
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function javascriptFunctionFenceFrameBenchmarks(): Record<string, unknown> {
  const atLocation = (quoted: boolean): Record<string, SourceFrameBenchmark> => ({
    colors: javascriptFunctionFenceFrameBenchmark(true, true, quoted),
    colorsFullFallback: javascriptFunctionFenceFrameBenchmark(true, false, quoted),
    noColors: javascriptFunctionFenceFrameBenchmark(false, true, quoted),
    noColorsFullFallback: javascriptFunctionFenceFrameBenchmark(false, false, quoted)
  });
  return { quoted: atLocation(true), root: atLocation(false) };
}

function javascriptNestedFunctionFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true,
  quoted = false
): SourceFrameBenchmark {
  const sourcePrefix = quoted ? "> " : "";
  const opening = `${sourcePrefix}\`\`\`javascript\n`;
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    const delta = [
      `${sourcePrefix}function generated_${frame}(input) {`,
      `${sourcePrefix}  if (input) {`,
      `${sourcePrefix}    return input + ${frame};`,
      `${sourcePrefix}  }`,
      `${sourcePrefix}}`
    ].join("\n") + "\n";
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function javascriptNestedFunctionFenceFrameBenchmarks(): Record<string, unknown> {
  const atLocation = (quoted: boolean): Record<string, SourceFrameBenchmark> => ({
    colors: javascriptNestedFunctionFenceFrameBenchmark(true, true, quoted),
    colorsFullFallback: javascriptNestedFunctionFenceFrameBenchmark(true, false, quoted),
    noColors: javascriptNestedFunctionFenceFrameBenchmark(false, true, quoted),
    noColorsFullFallback: javascriptNestedFunctionFenceFrameBenchmark(false, false, quoted)
  });
  return { quoted: atLocation(true), root: atLocation(false) };
}

function typescriptFunctionFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true,
  quoted = false
): SourceFrameBenchmark {
  const sourcePrefix = quoted ? "> " : "";
  const opening = `${sourcePrefix}\`\`\`typescript\n`;
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    const delta = [
      `${sourcePrefix}function generated_${frame}(input: number): number {`,
      `${sourcePrefix}  return input + ${frame};`,
      `${sourcePrefix}}`
    ].join("\n") + "\n";
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function typescriptFunctionFenceFrameBenchmarks(): Record<string, unknown> {
  const atLocation = (quoted: boolean): Record<string, SourceFrameBenchmark> => ({
    colors: typescriptFunctionFenceFrameBenchmark(true, true, quoted),
    colorsFullFallback: typescriptFunctionFenceFrameBenchmark(true, false, quoted),
    noColors: typescriptFunctionFenceFrameBenchmark(false, true, quoted),
    noColorsFullFallback: typescriptFunctionFenceFrameBenchmark(false, false, quoted)
  });
  return { quoted: atLocation(true), root: atLocation(false) };
}

function quotedTypescriptFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true,
  quoteDepth: 1 | 2 | 3 | 4 = 1
): SourceFrameBenchmark {
  const sourcePrefix = "> ".repeat(quoteDepth);
  const opening = `${sourcePrefix}\`\`\`typescript\n`;
  const theme = createTheme(colorsEnabled);
  const optimized = incremental ? new RichMarkdown(opening, 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown(opening, 1, 0, theme.markdown);
  const times: number[] = [];
  let source = opening;
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      delta += `${sourcePrefix}const value_${index}: number = ${index}; // generated\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function quotedTypescriptFenceFrameBenchmarks(): Record<string, SourceFrameBenchmark> {
  return {
    colors: quotedTypescriptFenceFrameBenchmark(true),
    colorsFullFallback: quotedTypescriptFenceFrameBenchmark(true, false),
    noColors: quotedTypescriptFenceFrameBenchmark(false),
    noColorsFullFallback: quotedTypescriptFenceFrameBenchmark(false, false)
  };
}

function depthTwoTypescriptFenceFrameBenchmarks(): Record<string, SourceFrameBenchmark> {
  return {
    colors: quotedTypescriptFenceFrameBenchmark(true, true, 2),
    colorsFullFallback: quotedTypescriptFenceFrameBenchmark(true, false, 2),
    noColors: quotedTypescriptFenceFrameBenchmark(false, true, 2),
    noColorsFullFallback: quotedTypescriptFenceFrameBenchmark(false, false, 2)
  };
}

function deepTypescriptFenceFrameBenchmarks(): Record<string, unknown> {
  const atDepth = (quoteDepth: 3 | 4): Record<string, SourceFrameBenchmark> => ({
    colors: quotedTypescriptFenceFrameBenchmark(true, true, quoteDepth),
    colorsFullFallback: quotedTypescriptFenceFrameBenchmark(true, false, quoteDepth),
    noColors: quotedTypescriptFenceFrameBenchmark(false, true, quoteDepth),
    noColorsFullFallback: quotedTypescriptFenceFrameBenchmark(false, false, quoteDepth)
  });
  return { depth3: atDepth(3), depth4: atDepth(4) };
}

interface CrossLineQuoteFrameOptions {
  depth?: 1 | 2 | 3;
  incremental?: boolean;
}

function crossLineQuoteFrameBenchmark(
  colorsEnabled: boolean,
  options: CrossLineQuoteFrameOptions = {}
): SourceFrameBenchmark {
  const theme = createTheme(colorsEnabled);
  const incremental = options.incremental ?? true;
  const optimized = incremental ? new RichMarkdown("", 1, theme) : undefined;
  const fallback = incremental ? undefined : new Markdown("", 1, 0, theme.markdown);
  const times: number[] = [];
  let source = "";
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    const quote = "> ".repeat(options.depth ?? 1).trimEnd();
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      delta += index % 2 === 0
        ? `${quote} **quote ${index} starts across line\n`
        : `${quote} ends on ${index}** with generated output\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function typescriptFrameDelta(frame: number): string {
  let delta = "";
  for (let line = 0; line < 3; line += 1) {
    const index = frame * 3 + line;
    delta += `const value_${index}: number = ${index}; // stream output\n`;
  }
  return delta;
}

function typescriptFenceFrameBenchmark(colorsEnabled: boolean): SourceFrameBenchmark {
  const openingFence = "```typescript\n";
  const view = new RichMarkdown(openingFence, 1, createTheme(colorsEnabled));
  const times: number[] = [];
  let sourceCharacters = openingFence.length;
  for (let frame = 0; frame < 300; frame += 1) {
    const delta = typescriptFrameDelta(frame);
    sourceCharacters += delta.length;
    view.appendText(delta);
    const startedAt = performance.now();
    view.render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters,
    ...frameStatistics(times)
  };
}

function typescriptHighlightFrameBenchmark(): SourceFrameBenchmark {
  const highlighter = new CodeHighlighter(true);
  const times: number[] = [];
  let source = "";
  for (let frame = 0; frame < 300; frame += 1) {
    source += typescriptFrameDelta(frame);
    const startedAt = performance.now();
    highlighter.highlight(source, "typescript");
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function typescriptSingleOpenFenceFrameBenchmark(
  colorsEnabled: boolean,
  incremental = true
): SourceFrameBenchmark {
  const openingFence = "```typescript\nfunction generated(input: number): number {\n";
  const theme = createTheme(colorsEnabled);
  const fullHighlighter = new CodeHighlighter(colorsEnabled);
  const fallbackMarkdownTheme = {
    ...theme.markdown,
    highlightCode: (code: string, language?: string) => fullHighlighter.highlight(
      code,
      language === "typescript" || language === "ts" ? "tsx" : language
    )
  };
  const optimized = incremental ? new RichMarkdown(openingFence, 1, theme) : undefined;
  const fallback = incremental
    ? undefined
    : new Markdown(openingFence, 1, 0, fallbackMarkdownTheme);
  const times: number[] = [];
  let source = openingFence;
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let line = 0; line < 3; line += 1) {
      const index = frame * 3 + line;
      delta += ` const value_${index}: number = input + ${index}; // generated\n`;
    }
    source += delta;
    if (optimized) optimized.appendText(delta);
    else fallback!.setText(source);
    const startedAt = performance.now();
    (optimized ?? fallback!).render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters: source.length,
    ...frameStatistics(times)
  };
}

function typescriptBlockFenceFrameBenchmark(
  incremental: boolean
): SourceFrameBenchmark {
  const openingFence = `\`\`\`${incremental ? "typescript" : "tsx"}\n`;
  const view = new RichMarkdown(openingFence, 1, createTheme(true));
  const times: number[] = [];
  let sourceCharacters = openingFence.length;
  for (let frame = 0; frame < 300; frame += 1) {
    const lines = [
      `function generated_${frame}(input: number): number {`,
      "  // generated",
      `  const doubled_${frame}: number = input * 2;`,
      `  return doubled_${frame} + ${frame};`,
      "}"
    ];
    lines.push("");
    const delta = lines.join("\n") + "\n";
    sourceCharacters += delta.length;
    view.appendText(delta);
    const startedAt = performance.now();
    view.render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters,
    ...frameStatistics(times)
  };
}

function typescriptAdjacentFenceFrameBenchmark(
  incremental: boolean
): SourceFrameBenchmark {
  const openingFence = `\`\`\`${incremental ? "typescript" : "tsx"}\n`;
  const view = new RichMarkdown(openingFence, 1, createTheme(true));
  const times: number[] = [];
  let sourceCharacters = openingFence.length;
  for (let frame = 0; frame < 300; frame += 1) {
    let delta = "";
    for (let block = 0; block < 3; block += 1) {
      const index = frame * 3 + block;
      delta += `function value_${index}(): number {\n  return ${index};\n}\n`;
    }
    sourceCharacters += delta.length;
    view.appendText(delta);
    const startedAt = performance.now();
    view.render(100);
    times.push(performance.now() - startedAt);
  }
  return {
    sourceCharacters,
    ...frameStatistics(times)
  };
}

function activeToolTextSample(): ToolTextBenchmarkSample {
  const buffer = new BoundedToolText();
  const cpu = process.cpuUsage();
  const appendStartedAt = performance.now();
  for (let index = 0; index < activeToolDeltaCount; index += 1) {
    buffer.append("0123456789");
  }
  const appendWallMs = performance.now() - appendStartedAt;
  const appendCpu = process.cpuUsage(cpu);
  const materializeStartedAt = performance.now();
  const outputCharacters = buffer.value().length;
  const materializeWallMs = performance.now() - materializeStartedAt;
  return {
    appendCpuMs: rounded((appendCpu.user + appendCpu.system) / 1_000),
    appendWallMs: rounded(appendWallMs),
    materializeWallMs: rounded(materializeWallMs),
    outputCharacters,
    retainedCharacters: buffer.retainedCharacters
  };
}

function sample(): StreamBenchmarkSample {
  const blocks: Component[] = [];
  const stream = new AssistantStream(createTheme(false), (component) => blocks.push(component));
  stream.beginTurn();

  const cpu = process.cpuUsage();
  const ingestStartedAt = performance.now();
  for (let index = 0; index < deltaCount; index += 1) {
    stream.append(index % 17 === 0 ? "\n\nnext" : " token");
  }
  const ingestWallMs = performance.now() - ingestStartedAt;
  const ingestCpu = process.cpuUsage(cpu);

  const renderStartedAt = performance.now();
  for (const block of blocks) block.render(80);
  const renderWallMs = performance.now() - renderStartedAt;

  return {
    ingestCpuMs: rounded((ingestCpu.user + ingestCpu.system) / 1_000),
    ingestWallMs: rounded(ingestWallMs),
    renderWallMs: rounded(renderWallMs)
  };
}

function coreBenchmarks(): Record<string, unknown> {
  sample();
  const samples = Array.from({ length: sampleCount }, sample);
  activeToolTextSample();
  const activeToolTextSamples = Array.from({ length: sampleCount }, activeToolTextSample);
  return {
    deltaCount,
    median: {
      ingestCpuMs: rounded(median(samples.map((entry) => entry.ingestCpuMs))),
      ingestWallMs: rounded(median(samples.map((entry) => entry.ingestWallMs))),
      renderWallMs: rounded(median(samples.map((entry) => entry.renderWallMs)))
    },
    activeToolText: {
      deltaCount: activeToolDeltaCount,
      median: {
        appendCpuMs: rounded(median(activeToolTextSamples.map((entry) => entry.appendCpuMs))),
        appendWallMs: rounded(median(activeToolTextSamples.map((entry) => entry.appendWallMs))),
        materializeWallMs: rounded(median(
          activeToolTextSamples.map((entry) => entry.materializeWallMs)
        )),
        outputCharacters: rounded(median(
          activeToolTextSamples.map((entry) => entry.outputCharacters)
        )),
        retainedCharacters: rounded(median(
          activeToolTextSamples.map((entry) => entry.retainedCharacters)
        ))
      },
      samples: activeToolTextSamples
    },
    samples
  };
}

function verificationFrameBenchmarks(): NamedFrameBenchmark[] {
  const frames: NamedFrameBenchmark[] = [];
  const add = (name: string, benchmark: FrameBenchmark): void => {
    frames.push({ name, ...benchmark });
  };
  const addColorPair = (
    name: string,
    benchmark: (colorsEnabled: boolean) => FrameBenchmark
  ): void => {
    add(`${name}.colors`, benchmark(true));
    add(`${name}.no-colors`, benchmark(false));
  };

  add("plain", frameBenchmark());
  add("semantic", frameBenchmark("**bold prefix** "));
  addColorPair("root-list", (colors) => listFrameBenchmark(colors));
  addColorPair("table", (colors) => tableFrameBenchmark(colors));
  addColorPair("ordered-list", (colors) => listFrameBenchmark(colors, { ordered: true }));
  addColorPair("ordered-continuation", (colors) => listFrameBenchmark(colors, {
    orderedContinuation: true
  }));
  addColorPair("ordered-nested-list", (colors) => listFrameBenchmark(colors, {
    orderedNested: true
  }));
  addColorPair("nested-list", (colors) => listFrameBenchmark(colors, { nested: true }));
  addColorPair("nested-list-continuation", (colors) => listFrameBenchmark(colors, {
    nested: true,
    nestedContinuation: true
  }));
  addColorPair("loose-nested-list", (colors) => listFrameBenchmark(colors, {
    looseNested: true
  }));
  addColorPair("loose-ordered-list", (colors) => listFrameBenchmark(colors, {
    looseOrdered: true
  }));
  addColorPair("root-continuation", (colors) => listFrameBenchmark(colors, {
    continuation: true
  }));
  addColorPair("blockquote", (colors) => blockquoteFrameBenchmark(colors, true));
  for (const kind of ["bold", "code", "italic", "link"] as const) {
    addColorPair(`semantic-blockquote.${kind}`, (colors) => (
      semanticBlockquoteFrameBenchmark(kind, colors)
    ));
  }
  addColorPair("quoted-list", (colors) => quotedListFrameBenchmark(colors));
  addColorPair("loose-quoted-list", (colors) => quotedListFrameBenchmark(colors, {
    loose: true
  }));
  addColorPair("quoted-ordered-list", (colors) => quotedListFrameBenchmark(colors, {
    ordered: true
  }));
  addColorPair("nested-quoted-list", (colors) => quotedListFrameBenchmark(colors, {
    depth: 2
  }));
  addColorPair("depth-three-quoted-list", (colors) => quotedListFrameBenchmark(colors, {
    depth: 3
  }));
  addColorPair("quoted-continuation", (colors) => quotedListFrameBenchmark(colors, {
    continuation: true
  }));
  addColorPair("nested-blockquote.bold", (colors) => (
    nestedBlockquoteFrameBenchmark("bold", colors)
  ));
  addColorPair("nested-blockquote.plain", (colors) => (
    nestedBlockquoteFrameBenchmark("plain", colors)
  ));
  addColorPair("depth-three-blockquote", (colors) => (
    nestedBlockquoteFrameBenchmark("bold", colors, true, 3)
  ));
  addColorPair("depth-four-blockquote", (colors) => (
    nestedBlockquoteFrameBenchmark("bold", colors, true, 4)
  ));
  addColorPair("cross-line-quote", (colors) => crossLineQuoteFrameBenchmark(colors));
  addColorPair("nested-cross-line-quote", (colors) => crossLineQuoteFrameBenchmark(colors, {
    depth: 2
  }));
  addColorPair("depth-three-cross-line-quote", (colors) => (
    crossLineQuoteFrameBenchmark(colors, { depth: 3 })
  ));

  for (const quoted of [false, true]) {
    const location = quoted ? "quoted" : "root";
    addColorPair(`bash-fence.${location}`, (colors) => (
      bashFenceFrameBenchmark(colors, true, quoted)
    ));
    addColorPair(`javascript-fence.${location}`, (colors) => (
      javascriptFenceFrameBenchmark(colors, true, quoted)
    ));
    addColorPair(`javascript-function-fence.${location}`, (colors) => (
      javascriptFunctionFenceFrameBenchmark(colors, true, quoted)
    ));
    addColorPair(`javascript-nested-function-fence.${location}`, (colors) => (
      javascriptNestedFunctionFenceFrameBenchmark(colors, true, quoted)
    ));
    addColorPair(`typescript-function-fence.${location}`, (colors) => (
      typescriptFunctionFenceFrameBenchmark(colors, true, quoted)
    ));
    addColorPair(`json-fence.${location}`, (colors) => (
      jsonFenceFrameBenchmark(colors, true, quoted)
    ));
    addColorPair(`nested-json-fence.${location}`, (colors) => (
      nestedJsonFenceFrameBenchmark(colors, true, quoted)
    ));
    addColorPair(`python-f-string-fence.${location}`, (colors) => (
      pythonFStringFenceFrameBenchmark(colors, true, quoted)
    ));
  }
  addColorPair("python-fence.root", (colors) => pythonFenceFrameBenchmark(colors));
  addColorPair("python-fence.quoted", (colors) => quotedPythonFenceFrameBenchmark(colors));
  for (const depth of [1, 2, 3, 4] as const) {
    addColorPair(`typescript-fence.depth-${depth}`, (colors) => (
      quotedTypescriptFenceFrameBenchmark(colors, true, depth)
    ));
  }
  addColorPair("typescript-fence.root", (colors) => typescriptFenceFrameBenchmark(colors));
  add("typescript-blocks.colors", typescriptBlockFenceFrameBenchmark(true));
  add("typescript-adjacent.colors", typescriptAdjacentFenceFrameBenchmark(true));
  addColorPair("typescript-single-open", (colors) => (
    typescriptSingleOpenFenceFrameBenchmark(colors)
  ));
  return frames;
}

const requested = requestedBenchmark();
if (requested.kind === "verify") {
  console.log(JSON.stringify({
    profile: "tui-performance-gate",
    ...coreBenchmarks(),
    frames: verificationFrameBenchmarks()
  }, null, 2));
  process.exit(0);
}

if (requested.kind === "scenario") {
  const requestedScenario = requested.scenario;
  console.log(JSON.stringify({
    scenario: requestedScenario,
    ...(requestedScenario === "bash-fence"
      ? { bashFenceFrames: bashFenceFrameBenchmarks() }
      : requestedScenario === "javascript-fence"
        ? { javascriptFenceFrames: javascriptFenceFrameBenchmarks() }
        : requestedScenario === "javascript-function-fence"
          ? { javascriptFunctionFenceFrames: javascriptFunctionFenceFrameBenchmarks() }
          : requestedScenario === "javascript-nested-function-fence"
            ? { javascriptNestedFunctionFenceFrames: javascriptNestedFunctionFenceFrameBenchmarks() }
      : requestedScenario === "json-fence"
        ? { jsonFenceFrames: jsonFenceFrameBenchmarks() }
        : requestedScenario === "nested-json-fence"
          ? { nestedJsonFenceFrames: nestedJsonFenceFrameBenchmarks() }
      : requestedScenario === "loose-ordered-list"
        ? { looseOrderedListFrames: looseOrderedListFrameBenchmarks() }
      : requestedScenario === "loose-quoted-list"
        ? { looseQuotedListFrames: looseQuotedListFrameBenchmarks() }
        : requestedScenario === "python-fence"
          ? { pythonFenceFrames: pythonFenceFrameBenchmarks() }
          : requestedScenario === "python-f-string-fence"
            ? { pythonFStringFenceFrames: pythonFStringFenceFrameBenchmarks() }
          : requestedScenario === "quoted-typescript-fence"
            ? { quotedTypescriptFenceFrames: quotedTypescriptFenceFrameBenchmarks() }
            : requestedScenario === "typescript-function-fence"
              ? { typescriptFunctionFenceFrames: typescriptFunctionFenceFrameBenchmarks() }
            : requestedScenario === "depth-two-typescript-fence"
              ? { depthTwoTypescriptFenceFrames: depthTwoTypescriptFenceFrameBenchmarks() }
              : requestedScenario === "deep-typescript-fence"
                ? { deepTypescriptFenceFrames: deepTypescriptFenceFrameBenchmarks() }
                : { quotedPythonFenceFrames: quotedPythonFenceFrameBenchmarks() })
  }, null, 2));
  process.exit(0);
}

console.log(JSON.stringify({
  ...coreBenchmarks(),
  plainFrames: frameBenchmark(),
  semanticFrames: frameBenchmark("**bold prefix** "),
  listFrames: listFrameBenchmark(),
  tableFrames: {
    colors: tableFrameBenchmark(true),
    colorsFullFallback: tableFrameBenchmark(true, false),
    noColors: tableFrameBenchmark(false),
    noColorsFullFallback: tableFrameBenchmark(false, false)
  },
  orderedListFrames: {
    colors: listFrameBenchmark(true, { ordered: true }),
    colorsFullFallback: listFrameBenchmark(true, { incremental: false, ordered: true }),
    noColors: listFrameBenchmark(false, { ordered: true }),
    noColorsFullFallback: listFrameBenchmark(false, { incremental: false, ordered: true })
  },
  orderedContinuationFrames: {
    colors: listFrameBenchmark(true, { orderedContinuation: true }),
    colorsFullFallback: listFrameBenchmark(true, {
      incremental: false,
      orderedContinuation: true
    }),
    noColors: listFrameBenchmark(false, { orderedContinuation: true }),
    noColorsFullFallback: listFrameBenchmark(false, {
      incremental: false,
      orderedContinuation: true
    })
  },
  orderedNestedListFrames: {
    colors: listFrameBenchmark(true, { orderedNested: true }),
    colorsFullFallback: listFrameBenchmark(true, {
      incremental: false,
      orderedNested: true
    }),
    noColors: listFrameBenchmark(false, { orderedNested: true }),
    noColorsFullFallback: listFrameBenchmark(false, {
      incremental: false,
      orderedNested: true
    })
  },
  nestedListFrames: {
    colors: listFrameBenchmark(true, { nested: true }),
    colorsFullFallback: listFrameBenchmark(true, { incremental: false, nested: true }),
    noColors: listFrameBenchmark(false, { nested: true }),
    noColorsFullFallback: listFrameBenchmark(false, { incremental: false, nested: true })
  },
  nestedListContinuationFrames: {
    colors: listFrameBenchmark(true, { nested: true, nestedContinuation: true }),
    colorsFullFallback: listFrameBenchmark(true, {
      incremental: false,
      nested: true,
      nestedContinuation: true
    }),
    noColors: listFrameBenchmark(false, { nested: true, nestedContinuation: true }),
    noColorsFullFallback: listFrameBenchmark(false, {
      incremental: false,
      nested: true,
      nestedContinuation: true
    })
  },
  looseNestedListFrames: {
    colors: listFrameBenchmark(true, { looseNested: true }),
    colorsFullFallback: listFrameBenchmark(true, {
      incremental: false,
      looseNested: true
    }),
    noColors: listFrameBenchmark(false, { looseNested: true }),
    noColorsFullFallback: listFrameBenchmark(false, {
      incremental: false,
      looseNested: true
    })
  },
  looseOrderedListFrames: looseOrderedListFrameBenchmarks(),
  rootContinuationFrames: {
    colors: listFrameBenchmark(true, { continuation: true }),
    colorsFullFallback: listFrameBenchmark(true, { continuation: true, incremental: false }),
    noColors: listFrameBenchmark(false, { continuation: true }),
    noColorsFullFallback: listFrameBenchmark(false, {
      continuation: true,
      incremental: false
    })
  },
  blockquoteFrames: {
    colors: blockquoteFrameBenchmark(true, true),
    colorsFullFallback: blockquoteFrameBenchmark(true, false),
    noColors: blockquoteFrameBenchmark(false, true),
    noColorsFullFallback: blockquoteFrameBenchmark(false, false)
  },
  semanticBlockquoteFrames: {
    boldColors: semanticBlockquoteFrameBenchmark("bold", true),
    boldNoColors: semanticBlockquoteFrameBenchmark("bold", false),
    codeColors: semanticBlockquoteFrameBenchmark("code", true),
    italicColors: semanticBlockquoteFrameBenchmark("italic", true),
    linkColors: semanticBlockquoteFrameBenchmark("link", true)
  },
  quotedListFrames: {
    colors: quotedListFrameBenchmark(true),
    noColors: quotedListFrameBenchmark(false)
  },
  looseQuotedListFrames: looseQuotedListFrameBenchmarks(),
  bashFenceFrames: bashFenceFrameBenchmarks(),
  javascriptFenceFrames: javascriptFenceFrameBenchmarks(),
  javascriptFunctionFenceFrames: javascriptFunctionFenceFrameBenchmarks(),
  javascriptNestedFunctionFenceFrames: javascriptNestedFunctionFenceFrameBenchmarks(),
  typescriptFunctionFenceFrames: typescriptFunctionFenceFrameBenchmarks(),
  jsonFenceFrames: jsonFenceFrameBenchmarks(),
  nestedJsonFenceFrames: nestedJsonFenceFrameBenchmarks(),
  pythonFenceFrames: pythonFenceFrameBenchmarks(),
  pythonFStringFenceFrames: pythonFStringFenceFrameBenchmarks(),
  quotedPythonFenceFrames: quotedPythonFenceFrameBenchmarks(),
  quotedTypescriptFenceFrames: quotedTypescriptFenceFrameBenchmarks(),
  depthTwoTypescriptFenceFrames: depthTwoTypescriptFenceFrameBenchmarks(),
  deepTypescriptFenceFrames: deepTypescriptFenceFrameBenchmarks(),
  quotedOrderedListFrames: {
    colors: quotedListFrameBenchmark(true, { ordered: true }),
    noColors: quotedListFrameBenchmark(false, { ordered: true })
  },
  nestedQuotedListFrames: {
    colors: quotedListFrameBenchmark(true, { depth: 2 }),
    colorsFullFallback: quotedListFrameBenchmark(true, { depth: 2, incremental: false }),
    noColors: quotedListFrameBenchmark(false, { depth: 2 }),
    noColorsFullFallback: quotedListFrameBenchmark(false, { depth: 2, incremental: false })
  },
  depthThreeQuotedListFrames: {
    colors: quotedListFrameBenchmark(true, { depth: 3 }),
    colorsFullFallback: quotedListFrameBenchmark(true, { depth: 3, incremental: false }),
    noColors: quotedListFrameBenchmark(false, { depth: 3 }),
    noColorsFullFallback: quotedListFrameBenchmark(false, { depth: 3, incremental: false })
  },
  nestedBlockquoteFrames: {
    boldColors: nestedBlockquoteFrameBenchmark("bold", true),
    boldColorsFullFallback: nestedBlockquoteFrameBenchmark("bold", true, false),
    boldNoColors: nestedBlockquoteFrameBenchmark("bold", false),
    boldNoColorsFullFallback: nestedBlockquoteFrameBenchmark("bold", false, false),
    plainColors: nestedBlockquoteFrameBenchmark("plain", true),
    plainColorsFullFallback: nestedBlockquoteFrameBenchmark("plain", true, false)
  },
  depthThreeBlockquoteFrames: {
    colors: nestedBlockquoteFrameBenchmark("bold", true, true, 3),
    colorsFullFallback: nestedBlockquoteFrameBenchmark("bold", true, false, 3),
    noColors: nestedBlockquoteFrameBenchmark("bold", false, true, 3),
    noColorsFullFallback: nestedBlockquoteFrameBenchmark("bold", false, false, 3)
  },
  depthFourBlockquoteFrames: {
    colors: nestedBlockquoteFrameBenchmark("bold", true, true, 4),
    colorsFullFallback: nestedBlockquoteFrameBenchmark("bold", true, false, 4),
    noColors: nestedBlockquoteFrameBenchmark("bold", false, true, 4),
    noColorsFullFallback: nestedBlockquoteFrameBenchmark("bold", false, false, 4)
  },
  quotedContinuationFrames: {
    colors: quotedListFrameBenchmark(true, { continuation: true }),
    colorsFullFallback: quotedListFrameBenchmark(true, {
      continuation: true,
      incremental: false
    }),
    noColors: quotedListFrameBenchmark(false, { continuation: true }),
    noColorsFullFallback: quotedListFrameBenchmark(false, {
      continuation: true,
      incremental: false
    })
  },
  crossLineQuoteFrames: {
    colors: crossLineQuoteFrameBenchmark(true),
    noColors: crossLineQuoteFrameBenchmark(false)
  },
  nestedCrossLineQuoteFrames: {
    colors: crossLineQuoteFrameBenchmark(true, { depth: 2 }),
    colorsFullFallback: crossLineQuoteFrameBenchmark(true, {
      depth: 2,
      incremental: false
    }),
    noColors: crossLineQuoteFrameBenchmark(false, { depth: 2 }),
    noColorsFullFallback: crossLineQuoteFrameBenchmark(false, {
      depth: 2,
      incremental: false
    })
  },
  depthThreeCrossLineQuoteFrames: {
    colors: crossLineQuoteFrameBenchmark(true, { depth: 3 }),
    colorsFullFallback: crossLineQuoteFrameBenchmark(true, {
      depth: 3,
      incremental: false
    }),
    noColors: crossLineQuoteFrameBenchmark(false, { depth: 3 }),
    noColorsFullFallback: crossLineQuoteFrameBenchmark(false, {
      depth: 3,
      incremental: false
    })
  },
  typescriptFenceFrames: {
    adjacentBlocks: typescriptAdjacentFenceFrameBenchmark(true),
    adjacentFullFallback: typescriptAdjacentFenceFrameBenchmark(false),
    blocks: typescriptBlockFenceFrameBenchmark(true),
    blocksFullFallback: typescriptBlockFenceFrameBenchmark(false),
    colors: typescriptFenceFrameBenchmark(true),
    noColors: typescriptFenceFrameBenchmark(false),
    highlighterOnly: typescriptHighlightFrameBenchmark(),
    singleOpen: {
      colors: typescriptSingleOpenFenceFrameBenchmark(true),
      colorsFullFallback: typescriptSingleOpenFenceFrameBenchmark(true, false),
      noColors: typescriptSingleOpenFenceFrameBenchmark(false),
      noColorsFullFallback: typescriptSingleOpenFenceFrameBenchmark(false, false)
    }
  }
}, null, 2));
