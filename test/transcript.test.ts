import { describe, expect, test } from "bun:test";
import { Text } from "@earendil-works/pi-tui";

import { Transcript } from "../packages/zcode-tui/src/transcript.ts";

describe("TUI transcript", () => {
  test("separates top-level conversation blocks by one line", () => {
    const transcript = new Transcript();
    transcript.addBlock(new Text("› user", 0, 0));
    transcript.addBlock(new Text("assistant", 0, 0));
    transcript.addBlock(new Text("› next", 0, 0));

    expect(transcript.render(80).map((line) => line.trimEnd())).toEqual([
      "› user",
      "",
      "assistant",
      "",
      "› next",
      ""
    ]);
  });

  test("keeps only the intentional bottom margin after clearing", () => {
    const transcript = new Transcript();
    transcript.addBlock(new Text("first", 0, 0));
    transcript.clear();
    transcript.addBlock(new Text("restored", 0, 0));

    expect(transcript.render(80).map((line) => line.trimEnd())).toEqual(["restored", ""]);
  });

  test("does not reserve a bottom margin for an empty transcript", () => {
    expect(new Transcript().render(80)).toEqual([]);
  });
});
