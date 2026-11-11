import assert from "node:assert/strict";
import test from "node:test";

import { agentReportSequence } from "../plugins/herdr-zcode/hooks/report-sequence.mjs";

test("report sequence exceeds the previous timestamp scale", () => {
  const sequence = agentReportSequence(1_793_000_000_000, 0n);

  assert.ok(sequence > 10_000_000_000_000_000n);
});

test("report sequence remains ordered across adjacent milliseconds", () => {
  const first = agentReportSequence(1_000, 9_998_000n);
  const second = agentReportSequence(1_000, 9_999_000n);
  const nextMillisecond = agentReportSequence(1_001, 10_000_000n);

  assert.ok(first < second);
  assert.ok(second < nextMillisecond);
});
