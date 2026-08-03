import { asString, isRecord } from "../types.ts";
import { sanitizeTerminalText } from "../terminal-text.ts";
import type { SpecializedToolRenderOptions, SpecializedToolRenderResult } from "./types.ts";
import {
  booleanField,
  directText,
  nestedRecord,
  recordString,
  safeJson,
  toolSummary
} from "./helpers.ts";

export function questionRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const input = isRecord(options.input) ? options.input : undefined;
  const result = nestedRecord(options.result);
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const inputAnswers = isRecord(input?.answers) ? input.answers : undefined;
  const resultAnswers = isRecord(result?.answers) ? result.answers : undefined;
  const answers = { ...inputAnswers, ...resultAnswers };
  const hasAnswers = Object.keys(answers).length > 0;
  const lines: string[] = [];
  if (hasAnswers) {
    for (const [question, answer] of Object.entries(answers)) {
      const rendered = asString(answer) ?? safeJson(answer);
      const safeQuestion = sanitizeTerminalText(question, { preserveSgr: false }).replace(/\s+/gu, " ").trim();
      const safeAnswer = rendered
        ? sanitizeTerminalText(rendered, { preserveSgr: false }).trim()
        : undefined;
      if (safeAnswer) {
        const indentedAnswer = safeAnswer.split("\n").map((line) => `  ${line}`).join("\n");
        lines.push(`${options.theme.muted(safeQuestion)}\n${options.theme.accent(indentedAnswer)}`);
      }
    }
  } else if (questions.length > 0 && options.state.toLowerCase() === "waiting_permission") {
    lines.push(options.theme.muted(`Awaiting ${questions.length} ${questions.length === 1 ? "answer" : "answers"}`));
  }
  return {
    displayName: "Question",
    summary: toolSummary(options.name, options.input),
    body: lines.join("\n") || undefined,
    consumesResult: Boolean(result || hasAnswers)
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
