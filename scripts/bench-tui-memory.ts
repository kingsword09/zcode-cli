#!/usr/bin/env bun

import { RichMarkdown } from "../packages/zcode-tui/src/rich-markdown.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import { Transcript } from "../packages/zcode-tui/src/transcript.ts";

const blockCount = 10_000;
const sourceCharactersPerBlock = 1_000;
const unbounded = process.argv.includes("--unbounded");
const theme = createTheme(false);

Bun.gc(true);
const before = process.memoryUsage();
const transcript = new Transcript();
const unboundedBlocks: RichMarkdown[] = [];
let sourceCharacters = 0;
const startedAt = performance.now();
for (let index = 0; index < blockCount; index += 1) {
  const source = `block ${index} ${"x".repeat(
    Math.max(0, sourceCharactersPerBlock - `block ${index} `.length)
  )}`;
  sourceCharacters += source.length;
  const component = new RichMarkdown(source, 1, theme);
  if (unbounded) unboundedBlocks.push(component);
  else transcript.addBlock(component, { kind: "assistant" });
}
const buildWallMs = performance.now() - startedAt;
Bun.gc(true);
const after = process.memoryUsage();

console.log(JSON.stringify({
  mode: unbounded ? "unbounded-source-roots" : "bounded-transcript",
  input: {
    blocks: blockCount,
    sourceCharacters
  },
  retained: {
    blocks: unbounded ? unboundedBlocks.length : transcript.blockCount,
    discardedBlocks: unbounded ? 0 : transcript.discardedBlockCount,
    historyCharacters: unbounded ? sourceCharacters : transcript.retainedHistoryCharacters
  },
  memory: {
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    rssBytes: after.rss
  },
  wallMs: Number(buildWallMs.toFixed(3))
}, null, 2));
