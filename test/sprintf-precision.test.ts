import { createRequire } from "node:module";

import { describe, expect, test } from "bun:test";

// Resolve the formatter through the shell dependency, including nested installs.
const require = createRequire(import.meta.url);
const shellRequire = createRequire(require.resolve("just-bash"));
const { sprintf, vsprintf } = shellRequire("sprintf-js") as {
  sprintf(format: string, ...values: unknown[]): string;
  vsprintf(format: string, values: unknown[]): string;
};

describe("patched shell floating-point formatting", () => {
  test.each(["e", "f", "g"])("bounds oversized %s precision without a RangeError", (specifier) => {
    for (const precision of ["101", "999999", "9".repeat(310)]) {
      const format = `%.${precision}${specifier}`;
      const expected = sprintf(`%.100${specifier}`, 1.25);
      expect(sprintf(format, 1.25)).toBe(expected);
      expect(vsprintf(format, [1.25])).toBe(expected);
      expect(expected.length).toBeLessThanOrEqual(106);
    }
  });

  test("preserves ordinary precision, zero precision and string truncation", () => {
    expect(sprintf("%.2f %.0f %.0e %.3g", 1.25, 1.25, 1.25, 1.25)).toBe("1.25 1 1e+0 1.25");
    expect(sprintf("%.0g", 1.25)).toBe("1");
    expect(sprintf("%08.2f %d %.3s", 1.25, 42, "hello")).toBe("00001.25 42 hel");
    expect(sprintf("%.101s", "x".repeat(102))).toBe("x".repeat(101));
    expect(sprintf("%2$.101f", 0, 1.25)).toBe(sprintf("%.100f", 1.25));
    expect(sprintf("%(value).101f", { value: 1.25 })).toBe(sprintf("%.100f", 1.25));
  });
});
