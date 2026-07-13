import { asString, isRecord } from "./types.ts";

export interface PromptImageAttachment {
  type: "image";
  content: string;
  mediaType?: string;
  sizeBytes?: number;
}

export function clipboardImageAttachment(value: unknown): PromptImageAttachment | undefined {
  if (!isRecord(value)) return undefined;
  const dataUrl = asString(value.dataUrl);
  if (!dataUrl || !/^data:image\/[a-z0-9.+_-]+;base64,/iu.test(dataUrl)) return undefined;
  const mediaType = asString(value.mediaType);
  const sizeBytes = typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes)
    ? value.sizeBytes
    : undefined;
  return {
    type: "image",
    content: dataUrl,
    ...(mediaType ? { mediaType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {})
  };
}

export function promptInput(text: string, attachments: PromptImageAttachment[]): unknown {
  return attachments.length > 0 ? { text, attachments } : text;
}

function formatBytes(bytes?: number): string | undefined {
  if (bytes === undefined || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/u, "")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} MB`;
}

export function attachmentSummary(attachments: PromptImageAttachment[]): string {
  if (attachments.length === 0) return "";
  const totalBytes = attachments.reduce((sum, attachment) => sum + (attachment.sizeBytes ?? 0), 0);
  const size = totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : "";
  return `${attachments.length} image${attachments.length === 1 ? "" : "s"} attached${size}`;
}
