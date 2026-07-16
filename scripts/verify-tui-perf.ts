#!/usr/bin/env bun

import { join } from "node:path";

export const TUI_PERF_LIMITS = {
  activeToolAppendCpuMs: 16,
  activeToolAppendWallMs: 16,
  activeToolMaterializeWallMs: 4,
  activeToolOutputCharacters: 64_128,
  activeToolRetainedCharacters: 64_000,
  boundedTranscriptHeapDeltaBytes: 32 * 1024 * 1024,
  boundedTranscriptHistoryCharacters: 2_000_000,
  boundedTranscriptRetainedBlocks: 480,
  boundedTranscriptRssBytes: 192 * 1024 * 1024,
  commonFrameP95Ms: 4,
  coreIngestCpuMs: 4,
  coreIngestWallMs: 4,
  coreRenderWallMs: 16,
  minimumFrameProfiles: 108
} as const;

interface GateSummary {
  activeToolAppendCpuMs?: number;
  boundedTranscriptRssBytes?: number;
  coreIngestCpuMs?: number;
  frameCount: number;
  slowestFrames: Array<{ name: string; p95Ms: number }>;
}

export interface TuiPerfGateResult {
  failures: string[];
  summary: GateSummary;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function numberAt(
  root: unknown,
  path: readonly string[],
  failures: string[]
): number | undefined {
  const value = valueAt(root, path);
  const label = path.join(".");
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failures.push(`${label} is missing or not a finite number`);
    return undefined;
  }
  return value;
}

function stringAt(
  root: unknown,
  path: readonly string[],
  failures: string[]
): string | undefined {
  const value = valueAt(root, path);
  const label = path.join(".");
  if (typeof value !== "string") {
    failures.push(`${label} is missing or not a string`);
    return undefined;
  }
  return value;
}

function requireAtMost(
  label: string,
  value: number | undefined,
  limit: number,
  failures: string[]
): void {
  if (value !== undefined && value > limit) {
    failures.push(`${label} ${value} exceeds ${limit}`);
  }
}

function requireAtLeast(
  label: string,
  value: number | undefined,
  limit: number,
  failures: string[]
): void {
  if (value !== undefined && value < limit) {
    failures.push(`${label} ${value} is below ${limit}`);
  }
}

export function evaluateTuiPerfGate(
  streamProfile: unknown,
  memoryProfile: unknown
): TuiPerfGateResult {
  const failures: string[] = [];
  const profile = stringAt(streamProfile, ["profile"], failures);
  if (profile !== undefined && profile !== "tui-performance-gate") {
    failures.push(`profile ${JSON.stringify(profile)} is not tui-performance-gate`);
  }

  const coreIngestCpuMs = numberAt(streamProfile, ["median", "ingestCpuMs"], failures);
  const coreIngestWallMs = numberAt(streamProfile, ["median", "ingestWallMs"], failures);
  const coreRenderWallMs = numberAt(streamProfile, ["median", "renderWallMs"], failures);
  const activeToolAppendCpuMs = numberAt(
    streamProfile,
    ["activeToolText", "median", "appendCpuMs"],
    failures
  );
  const activeToolAppendWallMs = numberAt(
    streamProfile,
    ["activeToolText", "median", "appendWallMs"],
    failures
  );
  const activeToolMaterializeWallMs = numberAt(
    streamProfile,
    ["activeToolText", "median", "materializeWallMs"],
    failures
  );
  const activeToolOutputCharacters = numberAt(
    streamProfile,
    ["activeToolText", "median", "outputCharacters"],
    failures
  );
  const activeToolRetainedCharacters = numberAt(
    streamProfile,
    ["activeToolText", "median", "retainedCharacters"],
    failures
  );

  requireAtMost("core ingest CPU ms", coreIngestCpuMs, TUI_PERF_LIMITS.coreIngestCpuMs, failures);
  requireAtMost("core ingest wall ms", coreIngestWallMs, TUI_PERF_LIMITS.coreIngestWallMs, failures);
  requireAtMost("core render wall ms", coreRenderWallMs, TUI_PERF_LIMITS.coreRenderWallMs, failures);
  requireAtMost(
    "active tool append CPU ms",
    activeToolAppendCpuMs,
    TUI_PERF_LIMITS.activeToolAppendCpuMs,
    failures
  );
  requireAtMost(
    "active tool append wall ms",
    activeToolAppendWallMs,
    TUI_PERF_LIMITS.activeToolAppendWallMs,
    failures
  );
  requireAtMost(
    "active tool materialize wall ms",
    activeToolMaterializeWallMs,
    TUI_PERF_LIMITS.activeToolMaterializeWallMs,
    failures
  );
  requireAtMost(
    "active tool output characters",
    activeToolOutputCharacters,
    TUI_PERF_LIMITS.activeToolOutputCharacters,
    failures
  );
  requireAtMost(
    "active tool retained characters",
    activeToolRetainedCharacters,
    TUI_PERF_LIMITS.activeToolRetainedCharacters,
    failures
  );

  const framesValue = valueAt(streamProfile, ["frames"]);
  const frameSamples: Array<{ name: string; p95Ms: number }> = [];
  if (!Array.isArray(framesValue)) {
    failures.push("frames is missing or not an array");
  } else {
    const names = new Set<string>();
    for (const [index, frame] of framesValue.entries()) {
      if (!isRecord(frame)) {
        failures.push(`frames.${index} is not an object`);
        continue;
      }
      const name = stringAt(frame, ["name"], failures);
      const p95Ms = numberAt(frame, ["p95Ms"], failures);
      if (name === undefined || p95Ms === undefined) continue;
      if (names.has(name)) failures.push(`frame profile ${name} is duplicated`);
      names.add(name);
      frameSamples.push({ name, p95Ms });
      requireAtMost(
        `${name} p95 ms`,
        p95Ms,
        TUI_PERF_LIMITS.commonFrameP95Ms,
        failures
      );
    }
  }
  requireAtLeast(
    "frame profile count",
    frameSamples.length,
    TUI_PERF_LIMITS.minimumFrameProfiles,
    failures
  );

  const memoryMode = stringAt(memoryProfile, ["mode"], failures);
  if (memoryMode !== undefined && memoryMode !== "bounded-transcript") {
    failures.push(`memory mode ${JSON.stringify(memoryMode)} is not bounded-transcript`);
  }
  const inputBlocks = numberAt(memoryProfile, ["input", "blocks"], failures);
  const inputCharacters = numberAt(memoryProfile, ["input", "sourceCharacters"], failures);
  const retainedBlocks = numberAt(memoryProfile, ["retained", "blocks"], failures);
  const discardedBlocks = numberAt(memoryProfile, ["retained", "discardedBlocks"], failures);
  const historyCharacters = numberAt(
    memoryProfile,
    ["retained", "historyCharacters"],
    failures
  );
  const heapDeltaBytes = numberAt(memoryProfile, ["memory", "heapDeltaBytes"], failures);
  const rssBytes = numberAt(memoryProfile, ["memory", "rssBytes"], failures);

  requireAtLeast("memory input blocks", inputBlocks, 10_000, failures);
  requireAtLeast("memory input characters", inputCharacters, 10_000_000, failures);
  requireAtMost(
    "bounded Transcript retained blocks",
    retainedBlocks,
    TUI_PERF_LIMITS.boundedTranscriptRetainedBlocks,
    failures
  );
  requireAtLeast("bounded Transcript discarded blocks", discardedBlocks, 9_520, failures);
  requireAtMost(
    "bounded Transcript history characters",
    historyCharacters,
    TUI_PERF_LIMITS.boundedTranscriptHistoryCharacters,
    failures
  );
  requireAtMost(
    "bounded Transcript heap delta bytes",
    heapDeltaBytes,
    TUI_PERF_LIMITS.boundedTranscriptHeapDeltaBytes,
    failures
  );
  requireAtMost(
    "bounded Transcript RSS bytes",
    rssBytes,
    TUI_PERF_LIMITS.boundedTranscriptRssBytes,
    failures
  );

  return {
    failures,
    summary: {
      activeToolAppendCpuMs,
      boundedTranscriptRssBytes: rssBytes,
      coreIngestCpuMs,
      frameCount: frameSamples.length,
      slowestFrames: frameSamples
        .sort((left, right) => right.p95Ms - left.p95Ms)
        .slice(0, 5)
    }
  };
}

const root = join(import.meta.dir, "..");

async function runCommand(label: string, command: string[]): Promise<void> {
  console.log(`\n[verify:tui-perf] ${label}`);
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, CI: "1" },
    stderr: "inherit",
    stdout: "inherit"
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${label} failed with exit code ${exitCode}`);
}

async function runJsonCommand(label: string, command: string[]): Promise<unknown> {
  console.log(`\n[verify:tui-perf] ${label}`);
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, CI: "1" },
    stderr: "inherit",
    stdout: "pipe"
  });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${label} failed with exit code ${exitCode}`);
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error(`${label} did not produce valid JSON: ${output.slice(-1_000)}`);
  }
}

export async function verifyTuiPerf(): Promise<TuiPerfGateResult> {
  const bun = process.execPath;
  await runCommand("tests", [bun, "test"]);
  await runCommand("typecheck", [bun, "run", "typecheck"]);
  await runCommand("build", [bun, "run", "build"]);
  await runCommand("TUI smoke tests", [bun, "run", "check:tui"]);
  await runCommand("diff check", ["git", "diff", "--check"]);

  const streamProfile = await runJsonCommand("fresh stream/CPU profile", [
    bun,
    "scripts/bench-tui-stream.ts",
    "--verify"
  ]);
  const memoryProfile = await runJsonCommand("fresh bounded Transcript RSS profile", [
    bun,
    "--expose-gc",
    "scripts/bench-tui-memory.ts"
  ]);
  const result = evaluateTuiPerfGate(streamProfile, memoryProfile);
  console.log("\n[verify:tui-perf] performance summary");
  console.log(JSON.stringify(result.summary, null, 2));
  if (result.failures.length > 0) {
    throw new Error(`TUI performance gates failed:\n- ${result.failures.join("\n- ")}`);
  }
  console.log("\n[verify:tui-perf] all quality and performance gates passed");
  return result;
}

if (import.meta.main) {
  try {
    await verifyTuiPerf();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
