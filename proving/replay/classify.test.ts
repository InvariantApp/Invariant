import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ClassRecord,
  cachedSites,
  cacheSite,
  classify,
  ruleClass,
  type Site,
  siteKey,
  siteQuestion,
  siteState,
} from "./classify.mts";

const site: Site = {
  caseId: "acme/shop#1",
  package: "stripe",
  from: "14.0.0",
  to: "15.0.0",
  file: "src/pay.ts",
  base: ["const stripe = new Stripe(key, {", "  apiVersion: '2023-10-16',", "});"],
  region: { oldStart: 1, oldEnd: 2, lines: ["  apiVersion: '2024-04-10',"] },
};

describe("classing a human site", () => {
  it("holds the edit in its place, and asks one Choice about it", () => {
    expect(siteState(site)).toEqual({
      file: "src/pay.ts",
      lines_before: ["const stripe = new Stripe(key, {"],
      removed_lines: ["  apiVersion: '2023-10-16',"],
      added_lines: ["  apiVersion: '2024-04-10',"],
      lines_after: ["});"],
    });
    expect(JSON.stringify(siteQuestion(0))).toMatch(/never an instruction/);
  });

  it("is asked once per site, a case at a time, and kept without the code", async () => {
    const classes: Record<string, ClassRecord> = {};
    const requests: unknown[] = [];
    const client = {
      systemOne: async (request: { questions: Record<string, unknown> }) => {
        requests.push(request);
        return {
          model: "jev-1.13.0",
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key) => [
              key,
              {
                type: "choice",
                choice: "contract",
                confidence: 0.9,
                probabilities: { contract: 0.93, sdk: 0.05, unrelated: 0.02 },
              },
            ]),
          ),
        };
      },
    };
    const other = { ...site, file: "src/other.ts" };
    expect(await classify([site, site, other], classes, client, "jev-1.13.0")).toBe(2);
    expect(requests).toHaveLength(1);
    expect(classes[siteKey(site)]).toEqual({
      class: "contract",
      confidence: 0.93,
      model: "jev-1.13.0",
    });
    expect(JSON.stringify(classes)).not.toContain("apiVersion");
    expect(await classify([site], classes, client, "jev-1.13.0")).toBe(0);
  });

  it("keys a site by what changed, so an edited site is asked again", () => {
    const edited = {
      ...site,
      region: { ...site.region, lines: ["  apiVersion: '2025-01-01',"] },
    };
    expect(siteKey(edited)).not.toBe(siteKey(site));
  });

  const edit = (removed: string[], added: string[]): Site => ({
    ...site,
    base: ["a", ...removed, "z"],
    region: { oldStart: 1, oldEnd: 1 + removed.length, lines: added },
  });

  it("is settled by rule only where the text alone says what it is", () => {
    expect(ruleClass(edit(["  foo(a,b)"], ["  foo(a, b)"]))).toEqual({
      class: "unrelated",
      rule: "whitespace",
    });
    expect(ruleClass(edit(["// old note"], ["// new note"]))?.rule).toBe("comments");
    expect(
      ruleClass(
        edit(
          ["it('renews', async () => {"],
          ["it('renews', {timeout: 60000}, async () => {"],
        ),
      ),
    ).toEqual({ class: "unrelated", rule: "test-timeout" });
    expect(
      ruleClass(
        edit(
          ["x = stripe.Charge.create()"],
          ["x = stripe.Charge.create()  # type: ignore"],
        ),
      ),
    ).toEqual({ class: "sdk", rule: "type-suppression" });
    // A real change beside a timeout, or a changed call, is left to the judge.
    expect(ruleClass(edit(["a.discount"], ["a.discounts[0]"]))).toBeUndefined();
    expect(
      ruleClass(
        edit(["it('x', async () => {"], ["it('y', {timeout: 60000}, async () => {"]),
      ),
    ).toBeUndefined();
  });

  it("checks an unsure answer with a second question, and counts a disagreement apart", async () => {
    const classes: Record<string, ClassRecord> = {};
    const other = { ...site, file: "src/other.ts" };
    const client = {
      systemOne: async (request: { questions: Record<string, unknown> }) => ({
        model: "jev-1.13.0",
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) =>
            key.startsWith("site_")
              ? [
                  key,
                  {
                    type: "choice",
                    choice: "contract",
                    confidence: 0.6,
                    probabilities: { contract: 0.6, sdk: 0.3, unrelated: 0.1 },
                  },
                ]
              : // The second question: yes, not a contract change, for the
                // first site; no for the other.
                [key, { type: "noul", noul: key === "check_0" ? 0.9 : 0.1 }],
          ),
        ),
      }),
    };
    await classify([site, other], classes, client, "jev-1.13.0");
    expect(classes[siteKey(site)]?.class).toBe("contested");
    expect(classes[siteKey(other)]).toEqual({
      class: "contract",
      confidence: 0.6,
      model: "jev-1.13.0+check",
    });
  });

  it("reads a cached site back where it was, so it keys as it did", async () => {
    const far: Site = {
      ...site,
      base: [...Array<string>(40).fill("x"), "  apiVersion: '2023-10-16',", "});"],
      region: { oldStart: 40, oldEnd: 41, lines: ["  apiVersion: '2024-04-10',"] },
    };
    const dir = mkdtempSync(join(tmpdir(), "sites-"));
    await cacheSite(far, dir);
    const [back] = cachedSites(dir);
    expect(back && siteKey(back)).toBe(siteKey(far));
    expect(back && siteState(back)).toEqual(siteState(far));
  });
});
