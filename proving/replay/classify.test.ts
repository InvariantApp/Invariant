import { describe, expect, it } from "vitest";
import {
  type ClassRecord,
  classify,
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
});
