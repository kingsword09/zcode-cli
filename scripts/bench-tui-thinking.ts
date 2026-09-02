#!/usr/bin/env bun
// Benchmark for issue #117: O(n^2) thinking-stream rendering.
// Runs the same corpus through the HEAD ThinkingView (bounded live tail) and a
// faithful copy of the pre-fix component (7f3d73b, full-trace Markdown parse
// per frame) so both can be compared on the same machine and corpus.
//
// Usage:
//   bun scripts/bench-tui-thinking.ts            # compare old vs new
//   bun scripts/bench-tui-thinking.ts --verify   # pass/fail gates for HEAD
//   bun scripts/bench-tui-thinking.ts --stress   # 100k-line stress + CPU/memory/RSS

import { Box, Markdown, Text } from "@earendil-works/pi-tui";

import { ThinkingView } from "../packages/zcode-tui/src/thinking-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import { sanitizeTerminalText } from "../packages/zcode-tui/src/terminal-text.ts";

// --- Pre-fix ThinkingView (copy of 7f3d73b) ------------------------------

class LegacyThinkingView extends Box {
  private text = "";
  private completed = false;
  private expanded = false;
  private dirty = false;

  constructor(private readonly theme: ReturnType<typeof createTheme>) {
    super(1, 0);
  }

  append(delta: string): void {
    if (!delta) return;
    const sanitized = sanitizeTerminalText(delta, { preserveSgr: false });
    if (!sanitized) return;
    this.completed = false;
    this.text += sanitized;
    this.dirty = true;
  }

  setText(text: string): void {
    const sanitized = sanitizeTerminalText(text, { preserveSgr: false });
    if (this.text === sanitized) return;
    this.text = sanitized;
    this.dirty = true;
  }

  complete(): void {
    if (this.completed) return;
    this.completed = true;
    this.dirty = true;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.dirty = true;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasHiddenContent(): boolean {
    return this.completed && Boolean(this.text.trim()) && !this.expanded;
  }

  getSearchText(): string {
    return this.text;
  }

  override render(width: number): string[] {
    if (this.dirty) {
      this.rebuild();
      this.dirty = false;
    }
    return super.render(width);
  }

  private rebuild(): void {
    this.clear();
    const title = this.completed
      ? `${this.theme.muted("◇")} ${this.theme.bold("Thought")}${this.text.trim() && !this.expanded ? this.theme.muted(" · Ctrl+O to expand") : ""}`
      : `${this.theme.accent("◇")} ${this.theme.bold("Thinking")} ${this.theme.muted("· active")}`;
    this.addChild(new Text(title, 0, 0));
    if (this.text.trim() && (!this.completed || this.expanded)) {
      this.addChild(new Markdown(
        this.text,
        1,
        0,
        this.theme.markdown,
        { color: this.theme.muted, italic: true }
      ));
    }
  }
}

// --- Corpus ----------------------------------------------------------------

// Realistic GLM-style reasoning: mixed prose, markdown emphasis, occasional
// fenced blocks and CJK — exercise parser, wrap, and ANSI paths.
function reasoningCorpus(lines: number): string[] {
  const deltas: string[] = [];
  for (let index = 0; index < lines; index += 1) {
    switch (index % 6) {
      case 0:
        deltas.push(`分析第 ${index} 步：需要检查 \`reasoning_delta\` 的路径与终端布局约束。\n`);
        break;
      case 1:
        deltas.push(`**Hypothesis ${index}:** the renderer cost grows with trace length, so we\n`);
        break;
      case 2:
        deltas.push(`measure per-frame render time while the visible stream is still active.\n`);
        break;
      case 3:
        deltas.push(`- item ${index} with **bold** generated content and \`code\` details\n`);
        break;
      case 4:
        deltas.push("```typescript\nconst value_" + index + ": number = " + index + ";\n```\n");
        break;
      default:
        deltas.push(`继续评估方案 ${index} 的权衡，确认所有内容保持可读。\n`);
        break;
    }
  }
  return deltas;
}

// --- Measurement ------------------------------------------------------------

interface FrameStats {
  totalFrames: number;
  totalRenderMs: number;
  bucketCount: number;
  buckets: number[];
}

const buckets = 10;
const width = 100;

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function runStream(lines: number, view: ThinkingView | LegacyThinkingView): FrameStats {
  const deltas = reasoningCorpus(lines);
  const times: number[] = [];
  for (const delta of deltas) {
    view.append(delta);
    const startedAt = performance.now();
    view.render(width);
    times.push(performance.now() - startedAt);
  }
  const bucketSize = Math.ceil(times.length / buckets) || 1;
  const bucketAverages: number[] = [];
  for (let index = 0; index < times.length; index += bucketSize) {
    const slice = times.slice(index, index + bucketSize);
    bucketAverages.push(rounded(slice.reduce((sum, value) => sum + value, 0) / slice.length));
  }
  return {
    totalFrames: times.length,
    totalRenderMs: rounded(times.reduce((sum, value) => sum + value, 0)),
    bucketCount: bucketAverages.length,
    buckets: bucketAverages
  };
}

interface TrialResult {
  lines: number;
  traceCharacters: number;
  head: FrameStats;
}

function trial(lines: number): TrialResult {
  const theme = createTheme(false);
  const current = new ThinkingView(theme);
  const head = runStream(lines, current);
  const traceCharacters = current.getSearchText().length;
  return { lines, traceCharacters, head };
}

interface LegacyTrialResult extends TrialResult {
  legacy: FrameStats;
}

function legacyTrial(lines: number): LegacyTrialResult {
  const theme = createTheme(false);
  const current = new ThinkingView(theme);
  const legacy = new LegacyThinkingView(theme);
  const head = runStream(lines, current);
  const legacyStats = runStream(lines, legacy);
  const traceCharacters = current.getSearchText().length;
  return { lines, traceCharacters, head, legacy: legacyStats };
}

// --- Compare mode ------------------------------------------------------------

function compare(): void {
  console.log(JSON.stringify({
    profile: "tui-thinking-stream",
    width,
    trials: [200, 500, 1_000, 2_000].map((lines) => legacyTrial(lines))
  }, null, 2));
}

// --- Stress mode -------------------------------------------------------------

const stressLines = 100_000;

interface MemoryUsage {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
}

function currentMemory(): MemoryUsage {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external
  };
}

interface ResourceSample {
  wallMs: number;
  cpuMs: number;
  memory: MemoryUsage;
}

function measureResources(startedWall: number, startedCpu: NodeJS.CpuUsage): ResourceSample {
  const cpu = process.cpuUsage(startedCpu);
  return {
    wallMs: rounded(performance.now() - startedWall),
    cpuMs: rounded((cpu.user + cpu.system) / 1_000),
    memory: currentMemory()
  };
}

// Streams the corpus without keeping the per-frame time array so a 100k-line
// run cannot accumulate benchmark-side memory that pollutes the RSS delta.
function runStreamResourceful(
  lines: number,
  view: ThinkingView | LegacyThinkingView
): ResourceSample {
  const startedWall = performance.now();
  const startedCpu = process.cpuUsage();
  for (let index = 0; index < lines; index += 1) {
    view.append(deltaForLine(index));
    view.render(width);
  }
  return measureResources(startedWall, startedCpu);
}

function deltaForLine(index: number): string {
  switch (index % 6) {
    case 0:
      return `分析第 ${index} 步：需要检查 \`reasoning_delta\` 的路径与终端布局约束。\n`;
    case 1:
      return `**Hypothesis ${index}:** the renderer cost grows with trace length, so we\n`;
    case 2:
      return `measure per-frame render time while the visible stream is still active.\n`;
    case 3:
      return `- item ${index} with **bold** generated content and \`code\` details\n`;
    case 4:
      return "```typescript\nconst value_" + index + ": number = " + index + ";\n```\n";
    default:
      return `继续评估方案 ${index} 的权衡，确认所有内容保持可读。\n`;
  }
}

// The legacy component is quadratic; a full 100k-line run would take hours
// and even streaming to its own large checkpoints compounds quadratically
// (~30+ minutes). Probe each checkpoint in a FRESH legacy view: the cost of
// one render at line N is independent of how the trace was assembled, so a
// fresh 16k-line trace measures the same frame cost as position 16k of a
// 100k-line stream while keeping total benchmark time linear.
interface LegacyProbe {
  lines: number;
  lastFrameAverageMs: number;
  buildMs: number;
}

function legacyProbeCheckpoints(): LegacyProbe[] {
  const checkpoints = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000];
  const probes: LegacyProbe[] = [];
  const theme = createTheme(false);
  for (const target of checkpoints) {
    const view = new LegacyThinkingView(theme);
    const buildStarted = performance.now();
    for (let index = 0; index < target; index += 1) view.append(deltaForLine(index));
    const buildMs = performance.now() - buildStarted;
    // Warm one render so dirty-flag rebuild happens outside the probe.
    view.render(width);
    const samples: number[] = [];
    for (let probe = 0; probe < 5; probe += 1) {
      view.append(deltaForLine(target + probe));
      const startedAt = performance.now();
      view.render(width);
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    probes.push({
      lines: target,
      lastFrameAverageMs: rounded(samples[Math.floor(samples.length / 2)]!),
      buildMs: rounded(buildMs)
    });
  }
  return probes;
}

function linearSlope(probes: LegacyProbe[]): number {
  // Least squares over (lines, lastFrameAverageMs).
  const count = probes.length;
  const sumX = probes.reduce((sum, probe) => sum + probe.lines, 0);
  const sumY = probes.reduce((sum, probe) => sum + probe.lastFrameAverageMs, 0);
  const sumXY = probes.reduce((sum, probe) => sum + probe.lines * probe.lastFrameAverageMs, 0);
  const sumXX = probes.reduce((sum, probe) => sum + probe.lines * probe.lines, 0);
  const denominator = count * sumXX - sumX * sumX;
  return denominator === 0 ? 0 : (count * sumXY - sumX * sumY) / denominator;
}

function stressBenchmark(): void {
  const theme = createTheme(false);

  // Full 100k-line stream through HEAD, with CPU + memory around the whole
  // run, plus a tail of per-frame times to prove the last frames stay flat.
  const before = currentMemory();
  const head = new ThinkingView(theme);
  const headSample = runStreamResourceful(stressLines, head);
  const tailFrameTimes: number[] = [];
  for (let probe = 0; probe < 100; probe += 1) {
    head.append(deltaForLine(stressLines + probe));
    const startedAt = performance.now();
    head.render(width);
    tailFrameTimes.push(performance.now() - startedAt);
  }
  const after = currentMemory();
  const traceCharacters = head.getSearchText().length;

  // Retained memory after completing: only this.text + bounded tail remain.
  head.complete();
  head.render(width);

  // Legacy cannot run 100k lines; probe checkpoints instead.
  const legacyProbes = legacyProbeCheckpoints();
  const slopeMsPerLine = linearSlope(legacyProbes);
  const extrapolate = (lines: number): number => rounded(slopeMsPerLine * lines);

  console.log(JSON.stringify({
    profile: "tui-thinking-stream-stress",
    width,
    head: {
      lines: stressLines,
      traceCharacters,
      stream: headSample,
      tailFrames: {
        count: tailFrameTimes.length,
        averageMs: rounded(
          tailFrameTimes.reduce((sum, value) => sum + value, 0) / tailFrameTimes.length
        ),
        maxMs: rounded(Math.max(...tailFrameTimes))
      },
      memoryDelta: {
        rssBytes: after.rssBytes - before.rssBytes,
        heapUsedBytes: after.heapUsedBytes - before.heapUsedBytes,
        heapTotalBytes: after.heapTotalBytes - before.heapTotalBytes,
        externalBytes: after.externalBytes - before.externalBytes
      },
      rssAfterBytes: after.rssBytes
    },
    legacy: {
      mode: "checkpoint-probes",
      probes: legacyProbes,
      slopeMsPerLine: rounded(slopeMsPerLine),
      extrapolatedLastFrameMs: {
        at50kLines: extrapolate(50_000),
        at100kLines: extrapolate(100_000)
      }
    }
  }, null, 2));
}

// --- Verify mode -------------------------------------------------------------

// Gates for HEAD (issue #117): per-frame render cost must stay flat as the
// trace grows. last-bucket average <= first-bucket average + headroom, the
// largest trial's last bucket must stay under a small absolute ceiling, and
// the full 2,000-line stream must render every frame in bounded time overall.
const growthHeadroom = 0.5; // ms allowed between first and last bucket average
const absoluteCeilingMs = 4; // ms per frame in the largest trial's last bucket
const totalCeilingMs = 1_500; // ms for the whole 2,000-line trial

function verify(): void {
  const trials = [200, 500, 1_000, 2_000].map((lines) => trial(lines));
  const checks = trials.map((result) => {
    const first = result.head.buckets[0] ?? 0;
    const last = result.head.buckets[result.head.buckets.length - 1] ?? 0;
    return {
      lines: result.lines,
      traceCharacters: result.traceCharacters,
      firstBucketAverageMs: first,
      lastBucketAverageMs: last,
      totalRenderMs: result.head.totalRenderMs,
      growthMs: rounded(last - first),
      growthWithinHeadroom: last <= first + growthHeadroom
    };
  });
  const largest = checks[checks.length - 1]!;
  const summary = {
    profile: "tui-thinking-stream-gate",
    growthHeadroomMs: growthHeadroom,
    absoluteCeilingMs,
    totalCeilingMs,
    checks,
    largestTrialLastBucketUnderCeiling: largest.lastBucketAverageMs <= absoluteCeilingMs,
    largestTrialTotalUnderCeiling: largest.totalRenderMs <= totalCeilingMs
  };
  console.log(JSON.stringify(summary, null, 2));
  const pass = checks.every((check) => check.growthWithinHeadroom)
    && summary.largestTrialLastBucketUnderCeiling
    && summary.largestTrialTotalUnderCeiling;
  process.exit(pass ? 0 : 1);
}

if (process.argv.includes("--verify")) verify();
else if (process.argv.includes("--stress")) stressBenchmark();
else compare();
