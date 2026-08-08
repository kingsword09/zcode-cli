import { describe, expect, test } from "bun:test";

import { WorkspaceAutocompleteProvider } from "../packages/zcode-tui/src/workspace-autocomplete.ts";
import type { SkillSuggestionResult } from "../packages/zcode-tui/src/types.ts";

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("workspace $ skill autocomplete", () => {
  test("queries the runtime skill lister and inserts a selected skill", async () => {
    let calls = 0;
    const provider = new WorkspaceAutocompleteProvider(
      [],
      process.cwd(),
      undefined,
      async () => {
        calls += 1;
        return {
          skills: [
            { name: "animate", description: "Add motion to a feature." }
          ]
        } satisfies SkillSuggestionResult;
      }
    );
    const input = "polish $anim";

    const suggestions = await provider.getSuggestions([input], 0, input.length, {
      signal: signal()
    });

    expect(calls).toBe(1);
    expect(suggestions).toEqual({
      prefix: "$anim",
      items: [
        { value: "$animate", label: "animate", description: "Add motion to a feature." }
      ]
    });

    const completion = provider.applyCompletion(
      [input],
      0,
      input.length,
      suggestions!.items[0]!,
      suggestions!.prefix
    );
    expect(completion).toEqual({
      lines: ["polish $animate "],
      cursorLine: 0,
      cursorCol: "polish $animate ".length
    });
  });

  test("uses qualifiedName when present so plugin skills stay disambiguable", async () => {
    const provider = new WorkspaceAutocompleteProvider(
      [],
      process.cwd(),
      undefined,
      async () =>
        ({
          skills: [
            {
              name: "control-browser",
              qualifiedName: "browser-use:control-browser",
              description: "Drive a browser."
            }
          ]
        }) satisfies SkillSuggestionResult
    );
    const input = "$control";

    const suggestions = await provider.getSuggestions([input], 0, input.length, {
      signal: signal()
    });

    expect(suggestions?.items[0]).toEqual({
      value: "$browser-use:control-browser",
      label: "browser-use:control-browser",
      description: "Drive a browser."
    });
  });

  test("filters case-insensitively on name and qualifiedName", async () => {
    const provider = new WorkspaceAutocompleteProvider(
      [],
      process.cwd(),
      undefined,
      async () =>
        ({
          skills: [
            { name: "Distill", description: "Simplify." },
            { name: "document-skills:docx", qualifiedName: "document-skills:docx" }
          ]
        }) satisfies SkillSuggestionResult
    );

    const byName = await provider.getSuggestions(["$dis"], 0, 4, { signal: signal() });
    expect(byName?.items.map((item) => item.value)).toEqual(["$Distill"]);

    const byQualified = await provider.getSuggestions(["$doc"], 0, 4, { signal: signal() });
    expect(byQualified?.items.map((item) => item.value)).toEqual([
      "$document-skills:docx"
    ]);
  });

  test("does not query skills when there is no $ prefix and falls back to slash commands", async () => {
    let calls = 0;
    const provider = new WorkspaceAutocompleteProvider(
      [{ name: "help", description: "Show help" }],
      process.cwd(),
      undefined,
      async () => {
        calls += 1;
        return { skills: [{ name: "animate" }] } satisfies SkillSuggestionResult;
      }
    );

    const slash = await provider.getSuggestions(["/he"], 0, 3, { signal: signal() });
    expect(slash).toMatchObject({
      prefix: "/he",
      items: [{ value: "help", label: "help", description: "Show help" }]
    });
    expect(calls).toBe(0);

    const plain = "just a normal sentence";
    expect(
      await provider.getSuggestions([plain], 0, plain.length, { signal: signal() })
    ).toBeNull();
    expect(calls).toBe(0);
  });

  test("ignores $ that is not at a token boundary", async () => {
    let calls = 0;
    const provider = new WorkspaceAutocompleteProvider(
      [],
      process.cwd(),
      undefined,
      async () => {
        calls += 1;
        return { skills: [{ name: "animate" }] } satisfies SkillSuggestionResult;
      }
    );

    // `a$b` keeps `$` mid-token (previous char is not a boundary), so it must
    // not trigger the skill lister — consistent with how `@` is handled.
    const input = "pay$cost";
    expect(
      await provider.getSuggestions([input], 0, input.length, { signal: signal() })
    ).toBeNull();
    expect(calls).toBe(0);
  });

  test("isolates skill-lister failures from the editor", async () => {
    const provider = new WorkspaceAutocompleteProvider(
      [],
      process.cwd(),
      undefined,
      async () => {
        throw new Error("skill discovery unavailable");
      }
    );

    expect(
      await provider.getSuggestions(["$an"], 0, 3, { signal: signal() })
    ).toBeNull();
  });

  test("declares $ as a trigger character", () => {
    const provider = new WorkspaceAutocompleteProvider([], process.cwd(), undefined, undefined);
    expect(provider.triggerCharacters).toContain("$");
  });

  test("does not duplicate whitespace after a completed mention", async () => {
    const provider = new WorkspaceAutocompleteProvider(
      [],
      process.cwd(),
      undefined,
      async () => ({ skills: [{ name: "animate" }] })
    );
    const input = "$anim existing";
    const suggestions = await provider.getSuggestions([input], 0, 5, { signal: signal() });
    const completion = provider.applyCompletion(
      [input],
      0,
      5,
      suggestions!.items[0]!,
      suggestions!.prefix
    );

    expect(completion).toEqual({
      lines: ["$animate existing"],
      cursorLine: 0,
      cursorCol: "$animate".length
    });
  });

  test("rejects unsafe identifiers and strips terminal controls from descriptions", async () => {
    const provider = new WorkspaceAutocompleteProvider(
      [],
      process.cwd(),
      undefined,
      async () => ({
        skills: [
          { name: "unsafe\u001b]52;c;dGVzdA==\u0007" },
          { name: "safe", description: "Clear\u001b[2J screen" }
        ]
      })
    );

    const suggestions = await provider.getSuggestions(["$"], 0, 1, { signal: signal() });
    expect(suggestions?.items).toEqual([
      { value: "$safe", label: "safe", description: "Clear screen" }
    ]);
  });
});
