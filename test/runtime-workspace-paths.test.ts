import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { withRecursiveWorkspacePathSuggestions } from "../src/runtime-workspace-paths.ts";
import { WorkspaceAutocompleteProvider } from "../packages/zcode-tui/src/workspace-autocomplete.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(files: string[]) {
  const root = await mkdtemp(join(tmpdir(), "zcode-workspace-paths-"));
  directories.push(root);
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "");
  }
  const reads: string[] = [];
  const fileSystemPort = {
    async listDirectory({ path }: { path: string }) {
      reads.push(relative(root, path) || ".");
      const entries = await readdir(path, { withFileTypes: true });
      return { entries: entries.map(entry => ({
        name: entry.name, path: join(path, entry.name),
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "symlink"
      })) };
    }
  };
  const nativeRequests: unknown[] = [];
  const options = { workspaceDirectory: root, fileSystemPort, excludedDirectories: new Set([".git", "node_modules"]) };
  const search = withRecursiveWorkspacePathSuggestions(async request => {
    nativeRequests.push(request);
    return { items: [], truncated: false };
  }, options);
  return { root, search, reads, options, nativeRequests };
}

describe("recursive runtime workspace paths", () => {
  test("finds the issue #240 files across directories and inserts the selected relative path", async () => {
    const { root, search } = await fixture([
      "First_folder/one.py", "First_folder/two.py", "Second_folder/one.py", "Second_folder/three.py"
    ]);
    expect(await search({ token: "@on" })).toEqual({
      items: [
        { kind: "file", path: "First_folder/one.py" },
        { kind: "file", path: "Second_folder/one.py" },
        { kind: "directory", path: "Second_folder/" }
      ], truncated: false
    });
    const editor = new WorkspaceAutocompleteProvider([], root, search);
    const input = "inspect @on";
    const suggestions = await editor.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
    expect(suggestions?.items[0]).toEqual({ value: "@First_folder/one.py", label: "one.py", description: "First_folder/one.py" });
    expect(editor.applyCompletion([input], 0, input.length, suggestions!.items[0]!, suggestions!.prefix).lines)
      .toEqual(["inspect @First_folder/one.py "]);
  });

  test("ranks exact names before prefixes and substrings across the entire tree before limiting", async () => {
    const { search } = await fixture(["z-last/stone.py", "z-last/one-extra.py", "a-first/deep/one.py", "one.py"]);
    expect(await search({ token: "@ONE.PY", limit: 2 })).toEqual({
      items: [{ kind: "file", path: "one.py" }, { kind: "file", path: "a-first/deep/one.py" }], truncated: true
    });
    expect((await search({ token: "@one", limit: 3 })).items.map(item => item.path))
      .toEqual(["one.py", "z-last/one-extra.py", "a-first/deep/one.py"]);
    expect((await search({ token: "@missing" })).items).toEqual([]);
    expect((await search({ token: "@one", limit: 0 })).items).toHaveLength(1);
    expect((await search({ token: "@one", limit: Number.NaN })).items).toHaveLength(4);
  });

  test("keeps empty tokens and explicit paths on the native provider", async () => {
    const { search, reads, nativeRequests } = await fixture(["src/one.py"]);
    for (const token of ["@", "@src/", "@src/on", "@src\\on", "@../on", "@/tmp/on", "@C:\\tmp\\on", "@.."]) {
      await search({ token, limit: 7 });
    }
    expect(nativeRequests).toHaveLength(8);
    expect(nativeRequests[2]).toEqual({ token: "@src/on", limit: 7 });
    expect(reads).toEqual([]);
  });

  test("searches beyond a full result list and multiple batches of directories", async () => {
    const { search, reads } = await fixture([
      ...Array.from({ length: 65 }, (_, index) => `group-${index}/stone.ts`),
      "a/deep/one.ts"
    ]);
    expect(await search({ token: "@one.ts", limit: 1 })).toEqual({
      items: [{ kind: "file", path: "a/deep/one.ts" }], truncated: true
    });
    expect(reads).toHaveLength(68);
  });

  test("preserves hidden-directory rules, exclusions and symlink boundaries", async () => {
    const { root, search, reads } = await fixture([
      "src/one.py", "src/.one.py", ".hidden/one.py", ".hidden/.one.py", "src/node_modules/one.py", ".git/.one.py"
    ]);
    await symlink(root, join(root, "cycle"), process.platform === "win32" ? "junction" : "dir");
    expect((await search({ token: "@one" })).items.map(item => item.path)).toEqual(["src/one.py"]);
    expect(reads).not.toContain("cycle");
    expect(reads).not.toContain(".hidden");
    expect(reads).not.toContain(join("src", "node_modules"));
    expect((await search({ token: "@.one" })).items.map(item => item.path)).toEqual([".hidden/.one.py", "src/.one.py"]);
    expect(reads).not.toContain(".git");
  });

  test("handles deep Unicode paths and quotes spaces through the actual TUI provider", async () => {
    const deepPath = `${"nested/".repeat(40)}源码/my file.ts`;
    const { root, search } = await fixture([deepPath]);
    const editor = new WorkspaceAutocompleteProvider([], root, search);
    const input = '@"my fi';
    const suggestions = await editor.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
    expect(suggestions?.items[0]?.value).toBe(`@"${deepPath}"`);
    expect(editor.applyCompletion([input], 0, input.length, suggestions!.items[0]!, suggestions!.prefix).lines)
      .toEqual([`@"${deepPath}" `]);
    expect((await search({ token: "@源码" })).items[0]?.kind).toBe("directory");
  });

  test("sees new and removed files on the next query", async () => {
    const { root, search } = await fixture(["src/old.ts"]);
    expect((await search({ token: "@new" })).items).toEqual([]);
    await writeFile(join(root, "src/new.ts"), "");
    expect((await search({ token: "@new" })).items).toEqual([{ kind: "file", path: "src/new.ts" }]);
    await rm(join(root, "src/new.ts"));
    expect((await search({ token: "@new" })).items).toEqual([]);
  });

  test("skips failed directories and entries outside the workspace", async () => {
    const { options, reads } = await fixture(["ok/one.py", "bad/one.py"]);
    const listDirectory = options.fileSystemPort.listDirectory;
    options.fileSystemPort.listDirectory = async request => {
      if (request.path === join(options.workspaceDirectory, "bad")) throw new Error("EACCES");
      const result = await listDirectory(request);
      result.entries.push({ name: "one.py", path: join(options.workspaceDirectory, "..", "one.py"), kind: "file" });
      return result;
    };
    const search = withRecursiveWorkspacePathSuggestions(async () => { throw new Error("unexpected native query"); }, options);
    expect((await search({ token: "@one" })).items).toEqual([{ kind: "file", path: "ok/one.py" }]);
    expect(reads).toContain("ok");
  });

  test("forwards cancellation and discards results without scheduling further directories", async () => {
    const { options, reads } = await fixture(["src/deep/one.py"]);
    const controller = new AbortController();
    const listDirectory = options.fileSystemPort.listDirectory;
    let received: AbortSignal | undefined;
    const search = withRecursiveWorkspacePathSuggestions(async () => ({ items: [], truncated: false }), {
      ...options,
      fileSystemPort: { async listDirectory(request, context) {
        received = context?.signal;
        const result = await listDirectory(request);
        controller.abort();
        return result;
      } }
    });
    expect(await search({ token: "@one", abortSignal: controller.signal })).toEqual({ items: [], truncated: false });
    expect(received).toBe(controller.signal);
    expect(reads).toEqual(["."]);
    await search({ token: "@one", abortSignal: controller.signal });
    expect(reads).toEqual(["."]);
  });
});
