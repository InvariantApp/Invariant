import { describe, expect, it } from "vitest";
import { hunksOf, languageOf } from "./sites.mts";

describe("the sites a human edited", () => {
  it("are the hunks of each source file's diff, with what each added and removed", () => {
    const patch = [
      "@@ -10,7 +10,7 @@ export async function charge(client) {",
      "   const intent = await client.paymentIntents.create({",
      "-    amount: total,",
      "+    amount: toMinor(total),",
      "     currency,",
      "@@ -40 +40,2 @@",
      "-import Stripe from 'stripe';",
      "+import Stripe from 'stripe';",
      "+import { toMinor } from './money';",
    ].join("\n");
    expect(hunksOf("src/pay.ts", patch)).toEqual([
      {
        file: "src/pay.ts",
        test: false,
        oldStart: 10,
        oldLines: 7,
        newStart: 10,
        newLines: 7,
        added: 1,
        removed: 1,
      },
      {
        file: "src/pay.ts",
        test: false,
        oldStart: 40,
        oldLines: 1,
        newStart: 40,
        newLines: 2,
        added: 2,
        removed: 1,
      },
    ]);
  });

  it("tells a fixed test apart from a fixed call site", () => {
    for (const file of [
      "src/pay.test.ts",
      "tests/test_pay.py",
      "pay_test.go",
      "__tests__/a.js",
    ]) {
      expect(hunksOf(file, "@@ -1 +1 @@\n-a\n+b")[0]?.test).toBe(true);
    }
    expect(hunksOf("src/contest.ts", "@@ -1 +1 @@\n-a\n+b")[0]?.test).toBe(false);
  });

  it("counts an npm case as TypeScript when the humans edited any TypeScript", () => {
    expect(languageOf({ ecosystem: "npm", files: ["a.js", "b.ts"] })).toBe("typescript");
    expect(languageOf({ ecosystem: "npm", files: ["a.js", "b.cjs"] })).toBe("javascript");
    expect(languageOf({ ecosystem: "pypi", files: ["a.py"] })).toBe("python");
  });
});
