import { describe, expect, test } from "bun:test";

import {
  buildSkillInvocationPrompt,
  normalizeSkillEntries,
  resolveSkillMentions,
  SkillCatalog
} from "../packages/zcode-tui/src/skills.ts";

describe("explicit skill invocation", () => {
  test("builds the same single-skill contract as the runtime /skill command", () => {
    expect(buildSkillInvocationPrompt(["audit"], "Review this change.")).toBe([
      "Use the skill named `audit` for this turn.",
      "First call the `Skill` tool with name `audit` before doing the task.",
      "After the skill content is loaded, follow its instructions and continue.",
      "",
      "User request:",
      "Review this change."
    ].join("\n"));
  });

  test("resolves selected qualified names and multiple mentions in prompt order", async () => {
    const catalog = new SkillCatalog(async () => ({
      skills: [
        { name: "audit" },
        { name: "control-browser", qualifiedName: "browser-use:control-browser" }
      ]
    }));

    const prepared = await catalog.preparePrompt(
      "Use $audit and $browser-use:control-browser, then summarize."
    );
    expect(prepared?.identifiers).toEqual(["audit", "browser-use:control-browser"]);
    expect(prepared?.text).toContain(
      "First call the `Skill` tool once for each of these names before doing the task"
    );
    expect(prepared?.text).toContain(
      "User request:\nUse $audit and $browser-use:control-browser, then summarize."
    );
  });

  test("uses a unique bare alias but skips ambiguous and unknown mentions", () => {
    const skills = normalizeSkillEntries({
      skills: [
        { name: "audit" },
        { name: "docx", qualifiedName: "documents:docx" },
        { name: "docx", qualifiedName: "office:docx" }
      ]
    });

    expect(resolveSkillMentions("$audit $missing $HOME", skills)).toEqual(["audit"]);
    expect(resolveSkillMentions("$docx", skills)).toEqual([]);
    expect(resolveSkillMentions("$documents:docx", skills)).toEqual(["documents:docx"]);
  });

  test("shares a short-lived discovery result between autocomplete and submission", async () => {
    let calls = 0;
    const catalog = new SkillCatalog(async () => {
      calls += 1;
      return { skills: [{ name: "audit" }] };
    });

    expect(await catalog.list()).toEqual([{ identifier: "audit", name: "audit" }]);
    expect((await catalog.preparePrompt("$audit this"))?.identifiers).toEqual(["audit"]);
    expect(calls).toBe(1);
  });

  test("treats synchronous discovery failures as unavailable completion", async () => {
    let calls = 0;
    const catalog = new SkillCatalog(() => {
      calls += 1;
      throw new Error("skill discovery unavailable");
    });
    expect(await catalog.list()).toEqual([]);
    expect(await catalog.preparePrompt("$audit this")).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("truncates descriptions without splitting emoji graphemes", () => {
    const [skill] = normalizeSkillEntries({
      skills: [{ name: "audit", description: `${"a".repeat(138)}😀xy` }]
    });
    expect(skill?.description).toBe(`${"a".repeat(138)}😀…`);
  });
});
