#!/usr/bin/env bun
/**
 * patch-runtime-stream.ts — post-sync patch for vendor/zcode.cjs.
 *
 * Adds a `--stream-json` flag to the bundled ZCode runtime's headless
 * `--prompt` mode. When set, the runtime streams qwen-compatible NDJSON events
 * to stdout (one JSON object per line) as the agent works, instead of printing
 * a single JSON summary at the end. This lets integrations like Multica
 * observe tool calls, thinking deltas, and assistant text in real time.
 *
 * The patch is purely string-based (no AST): the vendor bundle is minified,
 * so we anchor on stable, distinctive substrings. If an upstream runtime
 * upgrade changes those anchors, the patch fails loudly instead of silently
 * corrupting the bundle.
 *
 * Run automatically after sync-runtime.ts via `bun run sync`. Idempotent:
 * re-running on an already-patched bundle is a no-op.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = join(root, "vendor", "zcode.cjs");

/** Idempotency marker: the injected helper function name. Present = already patched. */
const PATCH_MARKER = "__zcodeStreamEmit";

/**
 * The onEvent callback injected into runPrompt's submitPrompt call.
 *
 * It receives raw runtime session events ({type, payload, sessionId, ...}) and
 * writes qwen-compatible NDJSON lines to stdout. The mapping mirrors
 * Multica's qwen backend schema so the Multica zcode adapter can reuse qwen's
 * streaming parser with minimal changes:
 *
 *   runtime event              → NDJSON line
 *   ─────────────────────────────────────────────────────────────
 *   model_streaming text_delta → {type:"assistant", message:{content:[{type:"text", text:delta}]}}
 *   model_streaming reasoning  → {type:"assistant", message:{content:[{type:"thinking", thinking:delta}]}}
 *   tool_call_scheduled        → {type:"assistant", message:{content:[{type:"tool_use", id, name, input}]}}
 *   tool_call_result           → {type:"user", message:{content:[{type:"tool_result", tool_use_id, content}]}}
 *   tool_call_error            → {type:"user", message:{content:[{type:"tool_result", tool_use_id, content, is_error:true}]}}
 *   turn_started               → {type:"system", session_id, subtype:"init"}
 *   turn_complete              → {type:"result", subtype, is_error, result, usage, session_id}
 *   turn_failed                → {type:"result", subtype:"error", is_error:true, error:{message}, session_id}
 *
 * Unknown event types are skipped (forward-compatible).
 */
const ON_EVENT_HELPER = `
var __zcodeStreamEmit = function(ev) {
  try {
    var p = ev.payload || {};
    var sid = ev.sessionId || "";
    var line = null;
    var t = ev.type;
    if (t === "turn_started") {
      line = { type: "system", subtype: "init", session_id: sid };
    } else if (t === "model_streaming") {
      var kind = p.kind;
      var delta = p.delta || "";
      if (kind === "text_delta" && delta) {
        line = { type: "assistant", session_id: sid, message: { content: [{ type: "text", text: delta }] } };
      } else if (kind === "reasoning_delta" && delta) {
        line = { type: "assistant", session_id: sid, message: { content: [{ type: "thinking", thinking: delta }] } };
      }
    } else if (t === "tool_call_scheduled") {
      var input = p.input;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch (e) {} }
      line = { type: "assistant", session_id: sid, message: { content: [{ type: "tool_use", id: p.toolCallId, name: p.toolName, input: input || {} }] } };
    } else if (t === "tool_call_result" || t === "tool_call_error") {
      var content = "";
      var r = p.result;
      if (typeof r === "string") { content = r; }
      else if (r && typeof r === "object") {
        content = r.content || r.output || r.stdout || "";
        if (typeof content !== "string") { try { content = JSON.stringify(content); } catch (e) { content = String(content); } }
      }
      var block = { type: "tool_result", tool_use_id: p.toolCallId, content: content };
      if (t === "tool_call_error") { block.is_error = true; }
      line = { type: "user", session_id: sid, message: { content: [block] } };
    } else if (t === "turn_complete") {
      var rt = p.resultType || "success";
      var isErr = rt !== "success" && rt !== "cancelled";
      var usage = p.usage || {};
      line = {
        type: "result",
        subtype: isErr ? "error" : "success",
        session_id: sid,
        is_error: isErr,
        result: p.response || "",
        usage: {
          input_tokens: usage.inputTokens || 0,
          output_tokens: usage.outputTokens || 0,
          cache_read_input_tokens: usage.cacheReadTokens || 0
        }
      };
    } else if (t === "turn_failed") {
      var errMsg = (p.error && p.error.message) ? p.error.message : "turn failed";
      line = { type: "result", subtype: "error_during_execution", session_id: sid, is_error: true, error: { message: errMsg } };
    }
    if (line) { process.stdout.write(JSON.stringify(line) + "\\n"); }
  } catch (e) { /* never let event emission break the turn */ }
};
`;

interface PatchSpec {
  /** Unique, stable anchor string present in the unpatched bundle. */
  anchor: string;
  /** Replacement string. */
  replacement: string;
  /** Human-readable description for error messages. */
  description: string;
}

/**
 * Patch 1 — argv parser: add `stream-json` boolean option.
 *
 * The runtime's global argv parser (parseArgs, strict mode) rejects unknown
 * flags. We add `"stream-json":{type:"boolean"}` right after the existing
 * `json:{type:"boolean"}` entry so `--stream-json` is accepted. The parsed
 * value surfaces as `o["stream-json"]` (values.json), which runPrompt reads
 * via the closure-captured options object.
 */
const ARGV_PATCH: Omit<PatchSpec, "replacement"> = {
  anchor: "json:{type:\"boolean\"},\"no-color\":{type:\"boolean\"}",
  description: "argv parser json option block"
};

/**
 * Patch 2 — runPrompt: inject onEvent + emit the stream-json branch.
 *
 * Anchor on the exact submitPrompt call inside runPrompt (function `wqt`).
 * The call passes `{abortSignal:y.signal}`; we extend it with `onEvent` and
 * gate on `o["stream-json"]` to decide whether to stream. When streaming, the
 * final summary print is suppressed (the terminal `result` NDJSON line already
 * carries response + usage).
 *
 * The replacement preserves the original code path when --stream-json is NOT
 * set, so existing `--prompt --json` behavior is unchanged.
 */
const SUBMIT_PROMPT_ANCHOR =
  "submitPrompt(r.length>0?{text:p,attachments:r.map(J=>({type:Vga(J),path:J}))}:p,{abortSignal:y.signal})";

const SUBMIT_PROMPT_REPLACEMENT =
  'submitPrompt(r.length>0?{text:p,attachments:r.map(J=>({type:Vga(J),path:J}))}:p,{abortSignal:y.signal,onEvent:o.streamJson?__zcodeStreamEmit:void 0})';

/**
 * Patch 3 — suppress the final summary print in stream-json mode.
 *
 * After submitPrompt returns, runPrompt does `o.json ? <print summary> : <print text>`.
 * In stream-json mode we must NOT print either (the stream already ended with a
 * `result` line). Replace the ternary head to short-circuit when stream-json.
 *
 * Note: runPrompt's `o` is built by the `lva` options builder (patch 4 below),
 * which exposes the parsed argv as `o.streamJson` (camelCase). We branch on
 * `o.streamJson` here and in the submitPrompt call.
 */
const SUMMARY_ANCHOR =
  "return m=W.traceId??m,o.json?(e.stdout.write(Sl({sessionId:f.sessionId,traceId:m";

const SUMMARY_REPLACEMENT =
  'return m=W.traceId??m,o.streamJson?0:o.json?(e.stdout.write(Sl({sessionId:f.sessionId,traceId:m';

/**
 * Patch 4 — lva options builder: map `stream-json` argv value to `o.streamJson`.
 *
 * `lva` is the function that constructs the options object passed to runPrompt
 * (as `o`). It explicitly copies selected argv fields (json, verbose, locale,
 * ...) into camelCase properties. We add `streamJson` so runPrompt can read
 * `o.streamJson` to decide whether to stream.
 *
 * Anchor: append `streamJson:e["stream-json"]===!0` after the `verbose` mapping,
 * which is a stable, distinctive suffix of the lva object literal.
 */
const LVA_ANCHOR = "noColor:e[\"no-color\"]===!0,verbose:e.verbose===!0";
const LVA_REPLACEMENT =
  "noColor:e[\"no-color\"]===!0,streamJson:e[\"stream-json\"]===!0,verbose:e.verbose===!0";

function fail(message: string): never {
  console.error(`patch-runtime-stream: ${message}`);
  process.exit(1);
}

function applyPatch(src: string, anchor: string, replacement: string, description: string): string {
  const count = src.split(anchor).length - 1;
  if (count === 0) {
    fail(`anchor not found for ${description}. The upstream runtime may have changed; inspect vendor/zcode.cjs and update the patch.`);
  }
  if (count > 1) {
    fail(`anchor matched ${count} times for ${description} (expected exactly 1). The anchor is no longer unique; make it more specific.`);
  }
  return src.replace(anchor, replacement);
}

function main(): void {
  let src: string;
  try {
    src = readFileSync(runtimePath, "utf8");
  } catch {
    fail(`cannot read ${runtimePath}. Run \`bun run sync\` first to extract the vendor runtime.`);
  }

  // Idempotent: a re-run on an already-patched bundle is a no-op.
  if (src.includes("__zcodeStreamEmit")) {
    console.log("patch-runtime-stream: already applied, skipping.");
    return;
  }

  // Patch 1: argv parser — add stream-json option.
  src = applyPatch(
    src,
    ARGV_PATCH.anchor,
    'json:{type:"boolean"},"stream-json":{type:"boolean"},"no-color":{type:"boolean"}',
    ARGV_PATCH.description
  );

  // Patch 2: runPrompt submitPrompt call — inject onEvent callback.
  src = applyPatch(src, SUBMIT_PROMPT_ANCHOR, SUBMIT_PROMPT_REPLACEMENT, "runPrompt submitPrompt call");

  // Patch 3: suppress summary print in stream-json mode.
  src = applyPatch(src, SUMMARY_ANCHOR, SUMMARY_REPLACEMENT, "runPrompt summary print branch");

  // Patch 4: lva options builder — map stream-json argv to o.streamJson.
  src = applyPatch(src, LVA_ANCHOR, LVA_REPLACEMENT, "lva options builder stream-json mapping");

  // Inject the onEvent helper at the bundle's global scope. The bundle starts
  // with `#!/usr/bin/env node\n"use strict";<rest>` — insert the helper right
  // after `"use strict";` so it lives at module top level (a legal statement
  // boundary) and is defined before runPrompt ever calls it.
  const useStrictAnchor = '"use strict";';
  const useStrictCount = src.split(useStrictAnchor).length - 1;
  if (useStrictCount < 1) {
    fail('cannot find "use strict"; at bundle head to insert helper.');
  }
  // Only replace the FIRST occurrence (the bundle's top-level directive).
  src = src.replace(useStrictAnchor, useStrictAnchor + ON_EVENT_HELPER);

  writeFileSync(runtimePath, src);
  console.log("patch-runtime-stream: applied streaming NDJSON support to vendor/zcode.cjs.");
}

main();
