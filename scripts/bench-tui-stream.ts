#!/usr/bin/env bun

import type { Component } from "@earendil-works/pi-tui";

import { AssistantStream } from "../packages/zcode-tui/src/assistant-stream.ts";
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

const deltaCount = 10_000;
const sampleCount = 5;

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

function plainFrameBenchmark(): FrameBenchmark {
  const view = new RichMarkdown("", 1, createTheme(false));
  const times: number[] = [];
  for (let frame = 0; frame < 1_000; frame += 1) {
    for (let token = 0; token < 10; token += 1) view.appendText(" token");
    const startedAt = performance.now();
    view.render(100);
    times.push(performance.now() - startedAt);
  }
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

sample();
const samples = Array.from({ length: sampleCount }, sample);
console.log(JSON.stringify({
  deltaCount,
  median: {
    ingestCpuMs: rounded(median(samples.map((entry) => entry.ingestCpuMs))),
    ingestWallMs: rounded(median(samples.map((entry) => entry.ingestWallMs))),
    renderWallMs: rounded(median(samples.map((entry) => entry.renderWallMs)))
  },
  plainFrames: plainFrameBenchmark(),
  samples
}, null, 2));
