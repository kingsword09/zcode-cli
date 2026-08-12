#!/usr/bin/env bun
/**
 * test-stream.ts — verify the patched runtime emits valid streaming NDJSON.
 *
 * Runs `zcode --prompt <text> --stream-json` against the patched vendor runtime
 * and asserts the output is well-formed NDJSON that matches the qwen-compatible
 * schema Multica's streaming adapter expects:
 *
 *   - every stdout line is valid JSON
 *   - the stream contains at least one event
 *   - the final event is type:"result"
 *   - a "result" event carries is_error:false on success and non-empty usage
 *
 * Exits non-zero on failure. Intended for `bun run check:stream` and CI.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = join(root, "vendor", "zcode.cjs");
const node = process.env.ZCODE_NODE?.trim() || process.execPath;

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  usage?: Record<string, number>;
  message?: { content?: Array<Record<string, unknown>> };
}

function fail(message: string): never {
  console.error(`test-stream: FAIL — ${message}`);
  process.exit(1);
}

async function runStream(prompt: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  return await new Promise((resolve, reject) => {
    const child = spawn(node, [runtimePath, "--prompt", prompt, "--stream-json", "--cwd", "/tmp"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      if (code !== 0) {
        reject(new Error(`runtime exited with ${code}\nstderr: ${stderr.slice(-1000)}`));
        return;
      }
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as StreamEvent);
        } catch (error) {
          reject(new Error(`non-JSON stdout line: ${trimmed.slice(0, 100)}`));
          return;
        }
      }
      resolve(events);
    });
  });
}

async function main(): Promise<void> {
  try {
    readFileSync(runtimePath, "utf8");
  } catch {
    fail(`cannot read ${runtimePath}. Run \`bun run sync:local\` first.`);
  }

  console.log("test-stream: running patched runtime with --stream-json...");
  const events = await runStream("reply with exactly the word hello");
  console.log(`test-stream: received ${events.length} events`);

  if (events.length === 0) {
    fail("no events emitted — the patch may not have applied. Run `bun run patch:stream`.");
  }

  const last = events[events.length - 1]!;
  if (last.type !== "result") {
    fail(`last event is ${last.type}, expected "result". Events: ${events.map((e) => e.type).join(", ")}`);
  }

  if (last.is_error) {
    fail(`result event reports is_error:true — result=${last.result ?? "(empty)"}`);
  }

  const usage = last.usage ?? {};
  if ((usage.input_tokens ?? 0) === 0 && (usage.output_tokens ?? 0) === 0) {
    fail(`result usage is all-zero: ${JSON.stringify(usage)}`);
  }

  const types = new Set(events.map((e) => e.type));
  if (!types.has("assistant") && !types.has("result")) {
    fail(`expected at least an assistant or result event, got: ${[...types].join(", ")}`);
  }

  console.log("test-stream: PASS");
  console.log(`  events: ${events.map((e) => e.type).join(" → ")}`);
  console.log(`  usage:  in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
