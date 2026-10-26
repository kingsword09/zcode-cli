import { isAbsolute, relative, sep } from "node:path";

interface PathSuggestion {
  kind: "file" | "directory";
  path: string;
}

interface SuggestionRequest {
  token: string;
  limit?: number;
  abortSignal?: AbortSignal;
}

interface SuggestionResult {
  items: PathSuggestion[];
  truncated: boolean;
}

type PathSuggestionProvider = (request: SuggestionRequest) => Promise<SuggestionResult>;

interface WorkspacePathOptions {
  workspaceDirectory: string;
  fileSystemPort: {
    listDirectory(request: { path: string }, options?: { signal?: AbortSignal }): Promise<{
      entries: { name: string; path: string; kind: string }[];
    }>;
  };
  excludedDirectories: ReadonlySet<string>;
}

interface RankedSuggestion {
  item: PathSuggestion;
  rank: number;
  depth: number;
}

function compare(first: RankedSuggestion, second: RankedSuggestion): number {
  return first.rank - second.rank
    || Number(first.item.kind === "file") - Number(second.item.kind === "file")
    || first.depth - second.depth
    || first.item.path.localeCompare(second.item.path);
}

/** Extend the runtime's native path completion with workspace-wide name searches. */
export function withRecursiveWorkspacePathSuggestions(
  native: PathSuggestionProvider,
  options: WorkspacePathOptions
): PathSuggestionProvider {
  return async (request) => {
    const empty: SuggestionResult = { items: [], truncated: false };
    if (request.abortSignal?.aborted) return empty;
    const query = request.token.replace(/^@/u, "");
    // Keep directory browsing, token validation and explicit paths upstream-owned.
    if (!query || query === ".." || /[\\/]/u.test(query)) return native(request);

    const normalizedQuery = query.toLowerCase();
    const includeHidden = query.startsWith(".");
    const limit = Number.isFinite(request.limit) ? Math.max(1, Math.floor(request.limit!)) : 50;
    const pending = [options.workspaceDirectory];
    const best: RankedSuggestion[] = [];
    let matches = 0;

    while (pending.length > 0) {
      if (request.abortSignal?.aborted) return empty;
      // Bound concurrent filesystem work; cancellation stops scheduling new reads.
      const listings = await Promise.all(pending.splice(-8).map(async (path) => {
        try {
          return (await options.fileSystemPort.listDirectory({ path }, { signal: request.abortSignal })).entries;
        } catch {
          // An unreadable or removed subdirectory must not hide other results.
          return [];
        }
      }));
      if (request.abortSignal?.aborted) return empty;
      for (const entries of listings) for (const entry of entries) {
        // The native adapter reports symlinks separately. Do not follow them.
        if (entry.kind !== "file" && entry.kind !== "directory") continue;
        if (entry.kind === "directory" && options.excludedDirectories.has(entry.name)) continue;
        if (!includeHidden && entry.name.startsWith(".")) continue;
        const path = relative(options.workspaceDirectory, entry.path);
        if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) continue;
        if (entry.kind === "directory") pending.push(entry.path);

        const name = entry.name.toLowerCase();
        if (!name.includes(normalizedQuery)) continue;
        matches += 1;
        const displayPath = path.split(sep).join("/");
        const candidate: RankedSuggestion = {
          item: { kind: entry.kind, path: entry.kind === "directory" ? `${displayPath}/` : displayPath },
          rank: name === normalizedQuery ? 0 : name.startsWith(normalizedQuery) ? 1 : 2,
          depth: displayPath.split("/").length
        };
        const index = best.findIndex((item) => compare(candidate, item) < 0);
        if (index >= 0) best.splice(index, 0, candidate);
        else if (best.length < limit) best.push(candidate);
        if (best.length > limit) best.pop();
      }
    }
    return { items: best.map(({ item }) => item), truncated: matches > limit };
  };
}
