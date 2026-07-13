import { describe, expect, test } from "bun:test";

import { SystemEventView } from "../packages/zcode-tui/src/system-event-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

describe("system event view", () => {
  test("keeps retry and error details compact until focused expansion", () => {
    const view = new SystemEventView(createTheme(false), {
      tone: "warning",
      title: "Retrying model request",
      summary: "attempt 2/3 in 1s",
      detail: "Provider overloaded"
    });
    expect(view.render(80).join("\n")).toContain("Ctrl+O to expand");
    expect(view.render(80).join("\n")).not.toContain("Provider overloaded");
    view.setExpanded(true);
    expect(view.render(80).join("\n")).toContain("Provider overloaded");
    expect(view.getSearchText()).toContain("Provider overloaded");
  });
});
