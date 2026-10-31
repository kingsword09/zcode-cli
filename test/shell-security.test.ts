import { expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const shellRequire = createRequire(require.resolve("just-bash"));
const { sprintf, vsprintf } = shellRequire("sprintf-js") as {
  sprintf(format: string, ...values: unknown[]): string;
  vsprintf(format: string, values: unknown[]): string;
};

test("untrusted shell format precision cannot trigger the known formatter denial of service", () => {
  for (const specifier of ["e", "f", "g"]) {
    const format = `%.${"9".repeat(310)}${specifier}`;
    const bounded = sprintf(`%.100${specifier}`, 1.25);
    expect(sprintf(format, 1.25)).toBe(bounded);
    expect(vsprintf(format, [1.25])).toBe(bounded);
    expect(bounded.length).toBeLessThanOrEqual(106);
  }
  expect(sprintf("%.2f %d %.3s", 1.25, 42, "hello")).toBe("1.25 42 hel");
});
