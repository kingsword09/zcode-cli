import { describe, expect, test } from "bun:test";

import {
  evaluateTuiPerfGate,
  TUI_PERF_LIMITS
} from "../scripts/verify-tui-perf.ts";

function passingStreamProfile(): unknown {
  return {
    profile: "tui-performance-gate",
    median: {
      ingestCpuMs: TUI_PERF_LIMITS.coreIngestCpuMs,
      ingestWallMs: TUI_PERF_LIMITS.coreIngestWallMs,
      renderWallMs: TUI_PERF_LIMITS.coreRenderWallMs
    },
    activeToolText: {
      median: {
        appendCpuMs: TUI_PERF_LIMITS.activeToolAppendCpuMs,
        appendWallMs: TUI_PERF_LIMITS.activeToolAppendWallMs,
        materializeWallMs: TUI_PERF_LIMITS.activeToolMaterializeWallMs,
        outputCharacters: TUI_PERF_LIMITS.activeToolOutputCharacters,
        retainedCharacters: TUI_PERF_LIMITS.activeToolRetainedCharacters
      }
    },
    frames: Array.from({ length: TUI_PERF_LIMITS.minimumFrameProfiles }, (_, index) => ({
      name: `frame-${index}`,
      p95Ms: TUI_PERF_LIMITS.commonFrameP95Ms
    }))
  };
}

function passingMemoryProfile(): unknown {
  return {
    mode: "bounded-transcript",
    input: {
      blocks: 10_000,
      sourceCharacters: 10_000_000
    },
    retained: {
      blocks: TUI_PERF_LIMITS.boundedTranscriptRetainedBlocks,
      discardedBlocks: 9_520,
      historyCharacters: TUI_PERF_LIMITS.boundedTranscriptHistoryCharacters
    },
    memory: {
      heapDeltaBytes: TUI_PERF_LIMITS.boundedTranscriptHeapDeltaBytes,
      rssBytes: TUI_PERF_LIMITS.boundedTranscriptRssBytes
    }
  };
}

describe("TUI performance verifier", () => {
  test("accepts every hard limit at its inclusive boundary", () => {
    const result = evaluateTuiPerfGate(passingStreamProfile(), passingMemoryProfile());

    expect(result.failures).toEqual([]);
    expect(result.summary.frameCount).toBe(TUI_PERF_LIMITS.minimumFrameProfiles);
  });

  test("reports p95, CPU, RSS, and coverage failures together", () => {
    const stream = passingStreamProfile() as {
      frames: Array<{ name: string; p95Ms: number }>;
      median: { ingestCpuMs: number };
    };
    stream.median.ingestCpuMs += 0.001;
    stream.frames[0]!.p95Ms += 0.001;
    stream.frames.length = TUI_PERF_LIMITS.minimumFrameProfiles - 1;
    const memory = passingMemoryProfile() as { memory: { rssBytes: number } };
    memory.memory.rssBytes += 1;

    const failures = evaluateTuiPerfGate(stream, memory).failures.join("\n");

    expect(failures).toContain("core ingest CPU ms");
    expect(failures).toContain("frame-0 p95 ms");
    expect(failures).toContain("frame profile count");
    expect(failures).toContain("bounded Transcript RSS bytes");
  });

  test("rejects missing metrics and duplicate frame names", () => {
    const stream = passingStreamProfile() as {
      activeToolText: { median: Record<string, unknown> };
      frames: Array<{ name: string; p95Ms: number }>;
    };
    delete stream.activeToolText.median.appendCpuMs;
    stream.frames[1]!.name = stream.frames[0]!.name;

    const failures = evaluateTuiPerfGate(stream, {}).failures.join("\n");

    expect(failures).toContain("appendCpuMs is missing");
    expect(failures).toContain("is duplicated");
    expect(failures).toContain("mode is missing");
    expect(failures).toContain("rssBytes is missing");
  });
});
