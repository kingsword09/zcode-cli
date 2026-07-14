import { describe, expect, test } from "bun:test";

import { WorkspaceAutocompleteProvider } from "../packages/zcode-tui/src/workspace-autocomplete.ts";
import type {
  WorkspacePathSuggestionRequest,
  WorkspacePathSuggestionResult
} from "../packages/zcode-tui/src/types.ts";

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("workspace @ autocomplete", () => {
  test("queries the official runtime callback and inserts a selected file", async () => {
    const requests: WorkspacePathSuggestionRequest[] = [];
    const provider = new WorkspaceAutocompleteProvider([], process.cwd(), async (request) => {
      requests.push(request);
      return {
        items: [{ kind: "file", path: "src/index.ts" }],
        truncated: false
      };
    });
    const input = "inspect @ind";

    const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: signal() });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ token: "@ind", limit: 50 });
    expect(requests[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(suggestions).toEqual({
      prefix: "@ind",
      items: [{ value: "@src/index.ts", label: "index.ts", description: "src/index.ts" }]
    });

    const completion = provider.applyCompletion(
      [input],
      0,
      input.length,
      suggestions!.items[0]!,
      suggestions!.prefix
    );
    expect(completion).toEqual({
      lines: ["inspect @src/index.ts "],
      cursorLine: 0,
      cursorCol: "inspect @src/index.ts ".length
    });
  });

  test("quotes paths with spaces and preserves an explicitly quoted token", async () => {
    const tokens: string[] = [];
    const provider = new WorkspaceAutocompleteProvider([], process.cwd(), async (request) => {
      tokens.push(request.token);
      return {
        items: [{ kind: "file", path: "docs/my file.md" }],
        truncated: false
      };
    });
    const input = 'read @"docs/my f';

    const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: signal() });
    expect(tokens).toEqual(["@docs/my f"]);
    expect(suggestions?.items[0]).toEqual({
      value: '@"docs/my file.md"',
      label: "my file.md",
      description: "docs/my file.md"
    });

    const completion = provider.applyCompletion(
      [input],
      0,
      input.length,
      suggestions!.items[0]!,
      suggestions!.prefix
    );
    expect(completion.lines).toEqual(['read @"docs/my file.md" ']);
    expect(completion.cursorCol).toBe(completion.lines[0]!.length);
  });

  test("keeps directory completion open for the next path segment", async () => {
    const tokens: string[] = [];
    const provider = new WorkspaceAutocompleteProvider([], process.cwd(), async (request) => {
      tokens.push(request.token);
      return {
        items: request.token.endsWith("/in")
          ? [{ kind: "file", path: "docs/my folder/index.md" }]
          : [{ kind: "directory", path: "docs/my folder/" }],
        truncated: false
      };
    });
    const input = 'open @"docs/my';
    const directorySuggestions = await provider.getSuggestions([input], 0, input.length, {
      signal: signal()
    });
    const completion = provider.applyCompletion(
      [input],
      0,
      input.length,
      directorySuggestions!.items[0]!,
      directorySuggestions!.prefix
    );

    expect(completion.lines).toEqual(['open @"docs/my folder/"']);
    expect(completion.cursorCol).toBe(completion.lines[0]!.length - 1);

    const continued = `${completion.lines[0]!.slice(0, completion.cursorCol)}in${completion.lines[0]!.slice(completion.cursorCol)}`;
    const fileSuggestions = await provider.getSuggestions(
      [continued],
      0,
      completion.cursorCol + 2,
      { signal: signal() }
    );
    expect(tokens).toEqual(["@docs/my", "@docs/my folder/in"]);
    expect(fileSuggestions?.items[0]?.value).toBe('@"docs/my folder/index.md"');
  });

  test("does not treat email addresses as file tokens and preserves slash completion", async () => {
    let workspaceQueries = 0;
    const provider = new WorkspaceAutocompleteProvider(
      [{ name: "help", description: "Show help" }],
      process.cwd(),
      async () => {
        workspaceQueries += 1;
        return { items: [], truncated: false };
      }
    );
    const email = "mail me@example.com";

    expect(await provider.getSuggestions([email], 0, email.length, { signal: signal() })).toBeNull();
    expect(workspaceQueries).toBe(0);

    const slash = await provider.getSuggestions(["/he"], 0, 3, { signal: signal() });
    expect(slash).toMatchObject({
      prefix: "/he",
      items: [{ value: "help", label: "help", description: "Show help" }]
    });
  });

  test("normalizes Windows separators and rejects paths outside the workspace", async () => {
    const provider = new WorkspaceAutocompleteProvider([], process.cwd(), async () => ({
      items: [
        { kind: "file", path: "../secret.txt" },
        { kind: "file", path: "/etc/passwd" },
        { kind: "file", path: "C:\\secrets.txt" },
        { kind: "file", path: "bad\nname.txt" },
        { kind: "file", path: 'bad"name.txt' },
        { kind: "file", path: "src\\index.ts" },
        { kind: "file", path: "src/index.ts" }
      ],
      truncated: false
    }));

    const suggestions = await provider.getSuggestions(["@src"], 0, 4, { signal: signal() });
    expect(suggestions?.items).toEqual([
      { value: "@src/index.ts", label: "index.ts", description: "src/index.ts" }
    ]);
  });

  test("forwards cancellation and isolates callback failures from the editor", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let resolveRequest: ((result: WorkspacePathSuggestionResult) => void) | undefined;
    const provider = new WorkspaceAutocompleteProvider([], process.cwd(), (request) => {
      requestSignal = request.abortSignal;
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    });

    const pending = provider.getSuggestions(["@src"], 0, 4, { signal: controller.signal });
    controller.abort();
    resolveRequest?.({
      items: [{ kind: "file", path: "src/index.ts" }],
      truncated: false
    });
    expect(await pending).toBeNull();
    expect(requestSignal).toBe(controller.signal);

    const failing = new WorkspaceAutocompleteProvider([], process.cwd(), async () => {
      throw new Error("search unavailable");
    });
    expect(await failing.getSuggestions(["@src"], 0, 4, { signal: signal() })).toBeNull();
  });

  test("supports an empty token and Unicode workspace paths", async () => {
    const tokens: string[] = [];
    const provider = new WorkspaceAutocompleteProvider([], process.cwd(), async (request) => {
      tokens.push(request.token);
      return {
        items: [{ kind: "file", path: "源码/入口.ts" }],
        truncated: false
      };
    });

    const root = await provider.getSuggestions(["@"], 0, 1, { signal: signal() });
    const unicodeInput = "检查 @入口";
    const unicode = await provider.getSuggestions([unicodeInput], 0, unicodeInput.length, {
      signal: signal()
    });

    expect(tokens).toEqual(["@", "@入口"]);
    expect(root?.items[0]?.value).toBe("@源码/入口.ts");
    expect(unicode?.prefix).toBe("@入口");
  });
});
