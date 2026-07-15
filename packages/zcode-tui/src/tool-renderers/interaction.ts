import { asString, isRecord } from "../types.ts";
import type { SpecializedToolRenderOptions, SpecializedToolRenderResult } from "./types.ts";
import {
  booleanField,
  directText,
  nestedRecord,
  oneLine,
  recordString,
  safeJson,
  toolSummary
} from "./helpers.ts";

export function questionRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const input = isRecord(options.input) ? options.input : undefined;
  const result = nestedRecord(options.result);
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const answers = isRecord(result?.answers) ? result.answers : undefined;
  const lines: string[] = [];
  if (answers) {
    for (const [question, answer] of Object.entries(answers)) {
      const rendered = asString(answer) ?? safeJson(answer);
      if (rendered) lines.push(`${options.theme.muted(oneLine(question, 72))}\n${options.theme.accent(`  ${oneLine(rendered, 100)}`)}`);
    }
  } else if (questions.length > 0 && options.state.toLowerCase() === "waiting_permission") {
    lines.push(options.theme.muted(`Awaiting ${questions.length} ${questions.length === 1 ? "answer" : "answers"}`));
  }
  return {
    displayName: "Question",
    summary: toolSummary(options.name, options.input),
    body: lines.join("\n") || undefined,
    consumesResult: Boolean(result)
  };
}

export function sendMessageRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const input = isRecord(options.input) ? options.input : undefined;
  const result = nestedRecord(options.result);
  const delivery = recordString(result, ["delivery"]);
  const status = recordString(result, ["status"]);
  const messageId = recordString(result, ["messageId", "message_id"]);
  const message = recordString(result, ["message", "error"]);
  const fullMessage = recordString(input, ["message"]);
  const details = [status, delivery, messageId && `id ${messageId}`].filter(Boolean).join(" · ");
  return {
    displayName: "Message",
    summary: toolSummary(options.name, options.input),
    body: [details && options.theme.muted(`└ ${details}`), message, options.expanded && fullMessage ? fullMessage : undefined].filter(Boolean).join("\n") || undefined,
    consumesResult: Boolean(result),
    hiddenContent: Boolean(fullMessage) && !options.expanded
  };
}

export function skillRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const raw = directText(options.result);
  const name = recordString(record, ["name"])
    ?? recordString(isRecord(options.input) ? options.input : undefined, ["skill", "name"]);
  const baseDirectory = recordString(record, ["baseDirectory"]);
  const truncated = booleanField(record, ["truncated"]);
  const content = recordString(record, ["content"]) ?? raw;
  const details = [baseDirectory, truncated ? "truncated" : undefined].filter(Boolean).join(" · ");
  return {
    displayName: "Skill",
    summary: name,
    body: [options.theme.muted(`└ Loaded${details ? ` · ${details}` : ""}`), options.expanded && content ? content : undefined].filter(Boolean).join("\n"),
    consumesResult: Boolean(record || raw),
    hiddenContent: Boolean(content) && !options.expanded
  };
}
