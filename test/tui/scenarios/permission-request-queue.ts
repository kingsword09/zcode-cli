import { join } from "node:path";

import type { TuiScenario } from "./types.ts";

export const permissionRequestQueueScenario: TuiScenario = {
  name: "permission-request-queue",
  description: "Serializes concurrent permission requests, including deny feedback.",
  fixture: join(import.meta.dir, "..", "fixtures", "permission-request-queue.ts"),
  async run(session) {
    await session.waitForScreen("scenario instructions", /Type “trigger permissions” to start/i);
    session.send("trigger permissions\r");
    await session.waitForScreen("first permission", /FIRST_WRITE_PERMISSION/iu);
    await session.sendAndWait(
      "3",
      "first permission feedback prompt",
      /Tell ZCode what should change before retrying\./iu
    );
    await session.assertScreenExcludes("second permission", /SECOND_BASH_PERMISSION/iu);
    await session.sendAndWait(
      "Use a temporary output file.\r",
      "second permission",
      /SECOND_BASH_PERMISSION/iu
    );
    await session.sendAndWait(
      "\r",
      "permission results",
      /Permission queue complete: deny · Use a temporary output file\. \| allow · Approved once/iu
    );
  }
};
