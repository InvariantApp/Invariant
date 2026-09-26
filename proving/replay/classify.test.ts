import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ClassRecord,
  cachedCases,
  cachedSites,
  cacheSite,
  classify,
  readCached,
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

  it("shows the judge the start of a line too long to read, and how much more there is", () => {
    const bundle = { ...site, region: { ...site.region, lines: ["x".repeat(1000)] } };
    expect(siteState(bundle)["added_lines"]).toEqual([
      `${"x".repeat(400)} ... 600 more characters`,
    ]);
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
    expect(
      ruleClass(
        edit(
          ['\t"github.com/google/go-github/v69/github"'],
          ['\t"github.com/google/go-github/v89/github"'],
        ),
      ),
    ).toEqual({ class: "sdk", rule: "module-version" });
    expect(
      ruleClass(
        edit(
          ['\tgithub "github.com/google/go-github/v88/github"'],
          ['\tgh "github.com/google/go-github/v89/github"'],
        ),
      ),
    ).toBeUndefined();
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

  it("checks, when asked, an unsure answer recorded before the check existed", async () => {
    const bump = edit(
      ['\t"github.com/google/go-github/v69/github"'],
      ['\t"github.com/google/go-github/v89/github"'],
    );
    const sure = { ...site, file: "src/sure.ts" };
    const checked = { ...site, file: "src/checked.ts" };
    const classes: Record<string, ClassRecord> = {
      [siteKey(site)]: { class: "contract", confidence: 0.55, model: "jev-1.13.0" },
      [siteKey(bump)]: { class: "contract", confidence: 0.63, model: "jev-1.13.0" },
      [siteKey(sure)]: { class: "contract", confidence: 0.9, model: "jev-1.13.0" },
      [siteKey(checked)]: {
        class: "contract",
        confidence: 0.6,
        model: "jev-1.13.0+check",
      },
    };
    const requests: { questions: Record<string, unknown> }[] = [];
    const client = {
      systemOne: async (request: { questions: Record<string, unknown> }) => {
        requests.push(request);
        return {
          model: "jev-1.13.0",
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key) => [
              key,
              { type: "noul", noul: 0.9 },
            ]),
          ),
        };
      },
    };
    await classify([site, bump, sure], classes, client, "jev-1.13.0");
    expect(requests).toHaveLength(0);
    await classify([site, bump, sure, checked], classes, client, "jev-1.13.0", {
      recheck: true,
    });
    expect(requests.map((request) => Object.keys(request.questions))).toEqual([
      ["check_0"],
    ]);
    expect(classes[siteKey(site)]?.class).toBe("contested");
    expect(classes[siteKey(bump)]).toEqual({
      class: "sdk",
      confidence: 1,
      model: "rule:module-version",
    });
    expect(classes[siteKey(sure)]?.model).toBe("jev-1.13.0");
    expect(classes[siteKey(checked)]?.model).toBe("jev-1.13.0+check");
  });

  it("settles a contested site, when asked, only where the third answer is sure", async () => {
    const sure = { ...site, file: "src/sure.ts" };
    const unsure = { ...site, file: "src/unsure.ts" };
    const asked = { ...site, file: "src/asked.ts" };
    const contested = (model: string): ClassRecord => ({
      class: "contested",
      confidence: 0.6,
      model,
    });
    const classes: Record<string, ClassRecord> = {
      [siteKey(sure)]: contested("jev-1.13.0+check"),
      [siteKey(unsure)]: contested("jev-1.13.0+check"),
      [siteKey(asked)]: contested("jev-1.13.0+settle"),
    };
    const requests: { questions: Record<string, unknown> }[] = [];
    const client = {
      systemOne: async (request: { questions: Record<string, unknown> }) => {
        requests.push(request);
        return {
          model: "jev-1.13.0",
          answers: {
            settle_0: { type: "choice", choice: "sdk", probabilities: { sdk: 0.91 } },
            settle_1: {
              type: "choice",
              choice: "contract",
              probabilities: { contract: 0.55 },
            },
          },
        };
      },
    };
    await classify([sure, unsure, asked], classes, client, "jev-1.13.0");
    expect(requests).toHaveLength(0);
    await classify([sure, unsure, asked], classes, client, "jev-1.13.0", {
      settle: true,
    });
    expect(requests.map((request) => Object.keys(request.questions))).toEqual([
      ["settle_0", "settle_1"],
    ]);
    expect(JSON.stringify(requests[0])).toMatch(/directly over HTTP/);
    expect(classes[siteKey(sure)]).toEqual({
      class: "sdk",
      confidence: 0.91,
      model: "jev-1.13.0+settle",
    });
    expect(classes[siteKey(unsure)]).toEqual({
      class: "contested",
      confidence: 0.55,
      model: "jev-1.13.0+settle",
    });
    expect(classes[siteKey(asked)]?.model).toBe("jev-1.13.0+settle");
  });

  it("settles a contested site by the narrow questions only outside the contract", async () => {
    const refactor = { ...site, file: "src/refactor.ts" };
    const alias = { ...site, file: "src/alias.ts" };
    const pin = { ...site, file: "src/pin.ts" };
    const asked = { ...site, file: "src/asked.ts" };
    const contested = (model: string): ClassRecord => ({
      class: "contested",
      confidence: 0.6,
      model,
    });
    const classes: Record<string, ClassRecord> = {
      [siteKey(refactor)]: contested("jev-1.13.0+settle"),
      [siteKey(alias)]: contested("jev-1.13.0+settle"),
      [siteKey(pin)]: contested("jev-1.13.0+settle"),
      [siteKey(asked)]: contested("jev-1.13.0+wire"),
    };
    // Each site's answers, by file: nothing on the wire, a wire name reached
    // another way, and a pin the judge is sure is on the wire but not that
    // the API needed it.
    const answers: Record<string, Record<string, number>> = {
      "src/refactor.ts": { wire: 0.07, api: 0.1, sdk: 0.2, unrelated: 0.9 },
      "src/alias.ts": { wire: 0.86, api: 0.4, sdk: 0.6, unrelated: 0.3 },
      "src/pin.ts": { wire: 0.98, api: 0.39, sdk: 0.19, unrelated: 0.16 },
    };
    const requests: { state: { site: { file: string } }; questions: object }[] = [];
    const client = {
      systemOne: async (request: { state: unknown; questions: object }) => {
        const asked = request as { state: { site: { file: string } }; questions: object };
        requests.push(asked);
        const given = answers[asked.state.site.file] ?? {};
        return {
          model: "jev-1.13.0",
          answers: Object.fromEntries(
            Object.entries(given).map(([key, noul]) => [key, { type: "noul", noul }]),
          ),
        };
      },
    };
    await classify([refactor, alias, pin, asked], classes, client, "jev-1.13.0", {
      narrow: true,
    });
    // One site to a request, and none asked twice.
    expect(requests.map((request) => request.state.site.file).sort()).toEqual([
      "src/alias.ts",
      "src/pin.ts",
      "src/refactor.ts",
    ]);
    expect(Object.keys(requests[0]?.questions ?? {})).toEqual([
      "wire",
      "api",
      "sdk",
      "unrelated",
    ]);
    expect(classes[siteKey(refactor)]).toEqual({
      class: "unrelated",
      confidence: 0.9,
      model: "jev-1.13.0+settle+wire",
    });
    // Neither is settled: one might be the contract, and none is ever
    // settled as the contract by these questions.
    expect(classes[siteKey(alias)]).toEqual(contested("jev-1.13.0+settle+wire"));
    expect(classes[siteKey(pin)]).toEqual(contested("jev-1.13.0+settle+wire"));

    // Asked everything once, nothing is asked again, whatever else is asked
    // for: an answer asked for twice could come back different.
    const before = JSON.stringify(classes);
    requests.length = 0;
    await classify([refactor, alias, pin, asked], classes, client, "jev-1.13.0", {
      recheck: true,
      settle: true,
      narrow: true,
    });
    expect(requests).toEqual([]);
    expect(JSON.stringify(classes)).toBe(before);
  });

  it("waits out a busy service rather than leaving sites unclassed", async () => {
    const classes: Record<string, ClassRecord> = {};
    let calls = 0;
    const client = {
      systemOne: async (request: { questions: Record<string, unknown> }) => {
        calls += 1;
        if (calls === 1)
          throw new Error("429 Rate limit exceeded. Please retry shortly.");
        return {
          model: "jev-1.13.0",
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key) => [
              key,
              { type: "choice", choice: "sdk", probabilities: { sdk: 0.95 } },
            ]),
          ),
        };
      },
    };
    expect(await classify([site], classes, client, "jev-1.13.0", { retryWait: 1 })).toBe(
      1,
    );
    expect(calls).toBe(2);
    expect(classes[siteKey(site)]?.class).toBe("sdk");
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

  it("is read back a case at a time, with the outcome it was scored with", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sites-"));
    const other = { ...site, caseId: "acme/other#2" };
    await cacheSite(site, dir, "flagged");
    await cacheSite(other, dir, "missed");
    const cases = cachedCases(dir);
    expect([...cases.keys()].sort()).toEqual(["acme/other#2", "acme/shop#1"]);
    const [back] = readCached(cases.get("acme/shop#1") ?? [], dir);
    expect(back?.outcome).toBe("flagged");
    expect(back && siteKey(back.site)).toBe(siteKey(site));
  });
});

describe("the site cache", () => {
  it("keeps whether a site was judged forced, so rescoring need not read the differ again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sites-"));
    const site = {
      caseId: "c#1",
      package: "stripe",
      from: "1",
      to: "2",
      file: "a.py",
      base: ["a = 1", "b = charge.amount_refunded", "c = 3"],
      region: { oldStart: 1, oldEnd: 2, lines: ["b = charge.refunds"] },
    };
    await cacheSite(site, dir, "missed", true);
    await cacheSite({ ...site, caseId: "c#2" }, dir, "missed");
    const read = readCached(readdirSync(dir).sort(), dir);
    expect(read.map((each) => each.forced).sort()).toEqual([true, undefined]);
  });
});
