import {
  Box,
  Text,
  type Component
} from "@earendil-works/pi-tui";

import {
  fileDiffsForPermission,
  FileDiffView
} from "./file-diff-view.ts";
import type { ZCodeTheme } from "./theme.ts";
import { normalizeToolName, recordString } from "./tool-renderers.ts";
import { isRecord } from "./types.ts";

const maxInputLines = 32;
const maxInputCharacters = 6_000;

function sanitizedJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value, (key, field) => {
      if (/api.?key|authorization|password|secret|token/iu.test(key) && typeof field === "string") return "[redacted]";
      if (typeof field === "string" && field.length > maxInputCharacters) return `${field.slice(0, maxInputCharacters)}…`;
      return field;
    }, 2);
  } catch {
    return String(value);
  }
}

function limited(value: string): string {
  const normalized = value.replace(/\r/g, "");
  const lines = normalized.split("\n");
  if (lines.length > maxInputLines) return `${lines.slice(0, maxInputLines).join("\n")}\n… ${lines.length - maxInputLines} more lines`;
  return normalized.length > maxInputCharacters ? `${normalized.slice(0, maxInputCharacters)}…` : normalized;
}

export class PermissionPreview implements Component {
  constructor(
    private readonly theme: ZCodeTheme,
    private readonly toolName: string,
    private readonly input: unknown,
    private readonly riskLevel?: string
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const host = new Box(1, 0, this.riskBackground());
    const risk = this.riskLevel ? this.riskStyle()(`Risk: ${this.riskLevel}`) : undefined;
    if (risk) host.addChild(new Text(risk, 0, 0));

    const diffs = fileDiffsForPermission(this.toolName, this.input);
    if (diffs.length > 0) {
      host.addChild(new FileDiffView(this.theme, {
        toolName: this.toolName,
        state: "waiting_permission",
        diffs
      }));
      return host.render(width);
    }

    const normalized = normalizeToolName(this.toolName);
    if ((normalized.includes("bash") || normalized.includes("shell") || normalized === "exec") && isRecord(this.input)) {
      const command = recordString(this.input, ["command", "cmd", "script"]);
      if (command) host.addChild(new Text(this.theme.bold(limited(command)), 0, 0));
      return host.render(width);
    }

    const input = sanitizedJson(this.input);
    if (input) host.addChild(new Text(this.theme.muted(limited(input)), 0, 0));
    return host.render(width);
  }

  private riskStyle(): (text: string) => string {
    if (this.riskLevel === "critical" || this.riskLevel === "high") return this.theme.error;
    if (this.riskLevel === "medium") return this.theme.warning;
    return this.theme.muted;
  }

  private riskBackground(): ((text: string) => string) | undefined {
    if (this.riskLevel === "critical" || this.riskLevel === "high") return this.theme.toolErrorBackground;
    return this.theme.toolPendingBackground;
  }
}
