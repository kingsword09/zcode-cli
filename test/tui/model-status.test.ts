import { expect, test } from "bun:test";
import { join } from "node:path";

import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

test.skipIf(process.platform === "win32")(
  "a recovered model failure leaves one status row instead of one error row per attempt",
  async () => {
    await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-model-status-" });
    await using session = TerminalSession.start({
      command: [process.execPath, join(import.meta.dir, "fixtures/model-status.ts")],
      workspace
    });
    await session.waitForScreen("scenario instructions", /recover a model request that failed/iu);
    session.send("recover stream\r");
    // The status row still reports the attempt while it is unresolved.
    await session.waitForScreen("stalled model status", /Model stream stalled\s+·\s+idle 60s/u);
    await session.waitForHistory(
      "recovered turn",
      /Recovered after reconnecting the model stream\./u
    );
    await session.settle();
    const recovered = session.screenText();
    // Two stalled and failed attempts were recovered, so no status row about them
    // may survive the successful request, and none may be appended per attempt.
    for (const statusRow of ["Model request failed", "Model stream stalled", "Retrying model request", "Recovering model stream"]) {
      expect(recovered).not.toContain(statusRow);
    }

    // An unrecoverable failure still has to be visible in the transcript.
    session.send("fail hard\r");
    await session.waitForHistory("terminal model failure", /Provider rejected the request\./u);
    await session.settle();
    expect(session.screenText().match(/Model request failed/gu) ?? []).toHaveLength(1);
    await session.exit();
  },
  20_000
);
