import { join } from "node:path";

import type { TuiScenario } from "./types.ts";

export const httpMockScenario: TuiScenario = {
  name: "http-mock",
  description: "Intercepts a fixture fetch through a strict, typed MSW boundary.",
  fixture: join(import.meta.dir, "..", "fixtures", "http-mock.ts"),
  async run(session, workspace) {
    await session.waitForScreen(
      "scenario instructions",
      /Type “fetch mocked catalog” to exercise a real fetch/iu,
      20_000
    );
    await session.sendAndWait(
      "fetch mocked catalog\r",
      "mocked model catalog",
      /Mock catalog: GLM-5 Mock, GLM-4\.7 Mock/iu
    );
    const runtimeJournal = await workspace.readRuntimeJournal();
    if (
      !runtimeJournal.includes('"kind":"http.request"')
      || !runtimeJournal.includes('"kind":"http.response"')
    ) {
      throw new Error(`The child fixture did not journal its mocked fetch.\n${runtimeJournal}`);
    }
  }
};
