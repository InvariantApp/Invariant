import { describe, expect, it } from "vitest";
import { agreement, narrowReport, sample } from "./audit.mts";
import { type Site, siteKey } from "./classify.mts";

const site = (file: string): Site => ({
  caseId: "acme/shop#1",
  package: "stripe",
  from: "1.0.0",
  to: "2.0.0",
  file,
  base: ["a", "b"],
  region: { oldStart: 1, oldEnd: 2, lines: ["c"] },
});

describe("the audit of the classes", () => {
  const sites = ["a.ts", "b.ts", "c.ts", "d.ts"].map(site);
  const classes = {
    [siteKey(sites[0] as Site)]: { class: "contract" as const, model: "jev" },
    [siteKey(sites[1] as Site)]: { class: "contract" as const, model: "jev" },
    [siteKey(sites[2] as Site)]: { class: "sdk" as const, model: "jev" },
    [siteKey(sites[3] as Site)]: {
      class: "unrelated" as const,
      model: "rule:whitespace",
    },
  };

  it("samples the same judged sites every time, a few from each class, none a rule decided", () => {
    const once = sample(sites, classes, 1).map(siteKey);
    expect(sample([...sites].reverse(), classes, 1).map(siteKey)).toEqual(once);
    expect(once).toHaveLength(2);
    expect(once).not.toContain(siteKey(sites[3] as Site));
  });

  it("counts agreement per class the classifier gave", () => {
    const result = agreement(classes, {
      about: "",
      reader: "test",
      labels: {
        [siteKey(sites[0] as Site)]: { label: "contract" },
        [siteKey(sites[1] as Site)]: { label: "unrelated" },
        [siteKey(sites[2] as Site)]: { label: "sdk" },
      },
    });
    expect(result).toEqual({
      labelled: 3,
      agreed: 2,
      byClass: { contract: { labelled: 2, agreed: 1 }, sdk: { labelled: 1, agreed: 1 } },
    });
  });

  it("reports what the narrow questions would settle, and any contract site among it", () => {
    const answer = (settled?: "sdk" | "unrelated") => ({
      wire: 0.1,
      api: 0.1,
      sdk: 0.2,
      unrelated: 0.9,
      model: "jev",
      ...(settled ? { settled } : {}),
    });
    expect(
      narrowReport([
        { label: "unrelated", given: "contested", answer: answer("unrelated") },
        { label: "sdk", given: "contested", answer: answer("unrelated") },
        { label: "contract", given: "contested", answer: answer() },
        { label: "contract", given: "contract", answer: answer("sdk") },
        { label: "sdk", given: "sdk", answer: undefined },
      ]),
    ).toEqual({
      asked: 5,
      settled: 3,
      outsideAgreed: 2,
      sameClass: 1,
      contractSettled: 1,
      contested: { labelled: 3, settled: 2, agreed: 1 },
    });
  });
});
