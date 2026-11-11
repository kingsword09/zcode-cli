const SLOTS_PER_MILLISECOND = 10_000n;

export function agentReportSequence(
  nowMs = Date.now(),
  monotonicNs = process.hrtime.bigint()
) {
  const monotonicMicroseconds = (monotonicNs / 1000n) % SLOTS_PER_MILLISECOND;
  return BigInt(nowMs) * SLOTS_PER_MILLISECOND + monotonicMicroseconds;
}
