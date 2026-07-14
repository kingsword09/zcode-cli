import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand
} from "@earendil-works/pi-tui";

import { isRecord, type ListWorkspacePathSuggestions } from "./types.ts";

const workspaceSuggestionLimit = 50;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/u;
const windowsDrivePattern = /^[a-zA-Z]:(?:\/|$)/u;

interface WorkspaceAtPrefix {
  callbackToken: string;
  prefix: string;
  quoted: boolean;
}

/**
 * Adds official-runtime workspace suggestions to pi-tui without replacing its
 * slash-command, local path or completion-editing behavior.
 */
export class WorkspaceAutocompleteProvider implements AutocompleteProvider {
  private readonly fallback: CombinedAutocompleteProvider;

  constructor(
    commands: (AutocompleteItem | SlashCommand)[] | undefined,
    basePath: string,
    private readonly listWorkspacePathSuggestions?: ListWorkspacePathSuggestions
  ) {
    this.fallback = new CombinedAutocompleteProvider(commands, basePath, null);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean }
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? "";
    const atPrefix = extractWorkspaceAtPrefix(currentLine.slice(0, cursorCol));
    if (!atPrefix || !this.listWorkspacePathSuggestions) {
      return await this.fallback.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    try {
      const result: unknown = await this.listWorkspacePathSuggestions({
        token: atPrefix.callbackToken,
        limit: workspaceSuggestionLimit,
        abortSignal: options.signal
      });
      if (options.signal.aborted) return null;

      const items = normalizeWorkspaceSuggestions(result, atPrefix.quoted);
      return items.length > 0 ? { items, prefix: atPrefix.prefix } : null;
    } catch {
      // Completion is optional UI assistance; runtime search failures must not
      // interrupt editing or prompt submission.
      return null;
    }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.fallback.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.fallback.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}

function extractWorkspaceAtPrefix(textBeforeCursor: string): WorkspaceAtPrefix | undefined {
  let marker = -1;
  for (let index = textBeforeCursor.length - 1; index >= 0; index -= 1) {
    if (
      textBeforeCursor[index] === "@" &&
      (index === 0 || textBeforeCursor[index - 1] === " " || textBeforeCursor[index - 1] === "\t")
    ) {
      marker = index;
      break;
    }
  }
  if (marker < 0) return undefined;

  const prefix = textBeforeCursor.slice(marker);
  if (prefix.startsWith('@"')) {
    if (prefix.slice(2).includes('"')) return undefined;
    return {
      callbackToken: `@${prefix.slice(2)}`,
      prefix,
      quoted: true
    };
  }
  if (/\s/u.test(prefix) || prefix.includes('"')) return undefined;
  return { callbackToken: prefix, prefix, quoted: false };
}

function normalizeWorkspaceSuggestions(result: unknown, preserveQuotes: boolean): AutocompleteItem[] {
  if (!isRecord(result) || !Array.isArray(result.items)) return [];

  const items: AutocompleteItem[] = [];
  const seen = new Set<string>();
  for (const candidate of result.items) {
    if (!isRecord(candidate) || (candidate.kind !== "file" && candidate.kind !== "directory")) {
      continue;
    }
    const path = normalizeWorkspacePath(candidate.path, candidate.kind);
    if (!path || seen.has(path)) continue;
    seen.add(path);

    const isDirectory = candidate.kind === "directory";
    const unqualifiedPath = isDirectory ? path.slice(0, -1) : path;
    const slashIndex = unqualifiedPath.lastIndexOf("/");
    const name = unqualifiedPath.slice(slashIndex + 1);
    const needsQuotes = preserveQuotes || /\s/u.test(path);

    items.push({
      value: needsQuotes ? `@"${path}"` : `@${path}`,
      label: `${name}${isDirectory ? "/" : ""}`,
      description: unqualifiedPath
    });
  }
  return items;
}

function normalizeWorkspacePath(value: unknown, kind: "file" | "directory"): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;

  const path = value.replace(/\\/gu, "/");
  if (
    path.startsWith("/") ||
    windowsDrivePattern.test(path) ||
    controlCharacterPattern.test(path) ||
    path.includes('"')
  ) {
    return undefined;
  }

  const hasTrailingSlash = path.endsWith("/");
  if (kind === "file" && hasTrailingSlash) return undefined;
  const pathWithoutSlash = hasTrailingSlash ? path.slice(0, -1) : path;
  const segments = pathWithoutSlash.split("/");
  if (
    pathWithoutSlash.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return undefined;
  }

  return kind === "directory" ? `${pathWithoutSlash}/` : pathWithoutSlash;
}
