/**
 * The differential check against the real provider fixture.
 *
 * Two of these tests exist because the earlier layers provably cannot catch
 * what they catch. The swapped value map round trips perfectly and keeps the
 * same set of allowed values, so closure and the lens laws both pass it; the
 * handler bug is not a shape change at all. If this file ever stops failing on
 * those two, the release gate has a hole in it.
 */
import { join } from "node:path";
import { ACME_BUILDS, AcmeStore, createAcmeApp } from "@fixtures/provider-acme";
import { loadConfig } from "@invariant/cli";
import { type ContractStep, chainProgram, predictDocument } from "@invariant/compiler";
import { loadContract, loadPendingChanges, loadReleaseStep } from "@invariant/contract";
import { breakingEntries, diffDocuments } from "@invariant/diff";
import type { Change } from "@invariant/ir";
import {
  checkDifferential,
  type Launcher,
  loadScenarios,
  type Scenario,
} from "@invariant/verifier";
import { beforeAll, describe, expect, it } from "vitest";

const FIXTURE = join(import.meta.dirname, "../fixtures/provider-acme");
const INVARIANT = join(FIXTURE, "invariant");

/**
 * Builds the compiled program the head build ships with.
 *
 * Taking `edit` lets a test seed a fault into one Change and watch the gate
 * find it, which is the only way to know the gate would find a real one.
 */
async function programFor(
  edit: (changes: Change[]) => Change[] = (changes) => changes,
): Promise<unknown> {
  const v1 = await loadContract(join(FIXTURE, "openapi/2026-01-15.json"), "2026-01-15");
  const v2 = await loadContract(join(FIXTURE, "openapi/2026-03-01.json"), "2026-03-01");
  const head = await loadContract(join(FIXTURE, "openapi/head.json"), "head");

  const steps: ContractStep[] = [
    {
      label: "2026-03-01",
      parent: "2026-01-15",
      from: v1.document,
      to: v2.document,
      changes: (await loadReleaseStep(INVARIANT, "2026-03-01")).changes,
    },
    {
      label: "head",
      parent: "2026-03-01",
      from: v2.document,
      to: head.document,
      changes: edit(await loadPendingChanges(INVARIANT)),
    },
  ];

  // How a request names its contract, from invariant.yaml, as compile reads it.
  const { identity } = await loadConfig(join(FIXTURE, "invariant.yaml"));
  return chainProgram(
    "acme-payments",
    head.label,
    head.digest,
    steps,
    identity ? { identity } : {},
  ).program;
}

/**
 * Starts a build in this process.
 *
 * Every call makes a new store, which is what lets the two base runs disagree
 * about identifiers and so lets volatility be measured rather than declared.
 * A provider's own CI runs the same comparison against real processes started
 * from `invariant.yaml`; nothing about the logic changes.
 */
/**
 * A clock the fixture cannot disagree with itself about.
 *
 * `AcmeStore` seeds its clock from `Date.now()` at construction, so three
 * launches of it can land in two different seconds. The calibration handles
 * that by design, but it made this file fail under load with three reported
 * differences that were all one clock tick, and a test that fails when the
 * machine is busy is not measuring the adapter.
 *
 * Fixing the clock makes `created` a value the two builds must agree on exactly,
 * which is a stronger check than treating it as volatile and ignoring it.
 * Generated identifiers still exercise the calibration.
 */
const FIXED_CLOCK = 1_760_000_000;

function launcherFor(
  program: unknown,
  headStore?: () => AcmeStore,
  /**
   * `fixed` everywhere a comparison has to come out equal, and `real` only in
   * the test that exists to prove clock-derived values are detected. That test
   * stays deterministic without a fixed clock, because the calibration waits for
   * the wall clock to cross a second between its two runs, so a value seeded
   * from the clock always differs between them. The flakes this file had were
   * in comparisons of the old build against the new one, never in that.
   */
  clock: "fixed" | "real" = "fixed",
): Launcher {
  return async (build) => {
    if (!(ACME_BUILDS as readonly string[]).includes(build)) {
      throw new Error(`unknown build ${build}`);
    }
    const head = build === "head";
    const app = createAcmeApp({
      build: build as (typeof ACME_BUILDS)[number],
      ...(head ? { program } : {}),
      store:
        head && headStore
          ? headStore()
          : new AcmeStore(clock === "fixed" ? { startClock: FIXED_CLOCK } : {}),
    });
    return {
      fetch: async (request) => app.fetch(request),
      close: async () => {},
    };
  };
}

/**
 * A provider whose domain logic changed, with no change to any shape.
 *
 * Payments that used to settle immediately now sit in an intermediate state.
 * Every schema still validates, every Change still round trips, the diff is
 * empty. What changed is what the API does, which is the one thing a
 * specification has never been able to describe.
 */
class DelayedSettlementStore extends AcmeStore {
  override createPayment(input: Parameters<AcmeStore["createPayment"]>[0]) {
    const payment = super.createPayment(input);
    payment.status = "processing";
    return payment;
  }
}

describe("the differential check", () => {
  let scenarios: Scenario[];

  beforeAll(async () => {
    scenarios = await loadScenarios(join(INVARIANT, "scenarios"));
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it("finds the old build and the new build plus adapter indistinguishable", async () => {
    const report = await checkDifferential(scenarios, {
      launch: launcherFor(await programFor()),
      contractHeader: "acme-version",
      currentLabel: "2026-09-20",
    });

    expect(report.differences).toEqual([]);
    expect(report.evidence.some((entry) => entry.result === "fail")).toBe(false);
    // The head-contract scenario is skipped here and covered by conformance.
    expect(report.evidence.filter((entry) => entry.result === "pass")).toHaveLength(2);
    expect(report.evidence.filter((entry) => entry.result === "skipped")).toHaveLength(1);
  });

  it("measures which paths the old build does not keep stable", async () => {
    const report = await checkDifferential(scenarios, {
      // The real clock, on purpose: this is the test that proves a timestamp is
      // found by running the old build against itself.
      launch: launcherFor(await programFor(), undefined, "real"),
      contractHeader: "acme-version",
      currentLabel: "2026-09-20",
    });

    const paths = report.volatile.get("create, retrieve and list a charge") ?? [];
    // Identifiers and timestamps, found by running the old build against
    // itself rather than by listing them anywhere.
    expect(paths).toContain("create/id");
    expect(paths).toContain("create/created");
    // The amount was sent by the caller, so it is not generated and must not
    // be excused. If this ever became volatile the check would stop proving
    // anything about money.
    expect(paths).not.toContain("create/amount");
  });

  /**
   * The fault the specification genuinely cannot express.
   *
   * `succeeded` and `pending` trade places. The map is still a bijection, the
   * round trip is still the identity, and the set of values the new contract
   * allows is unchanged, so closure and the lens laws both pass. Only asking
   * the two builds the same question finds it.
   */
  it("catches a value map whose pairs are swapped", async () => {
    const program = await programFor((changes) =>
      changes.map((change) =>
        change.id !== "chg_payment_status_vocabulary"
          ? change
          : {
              ...change,
              ops: [
                {
                  op: "convert",
                  path: "/status",
                  codec: {
                    kind: "enumMap",
                    pairs: [
                      ["succeeded", "processing"],
                      ["failed", "failed"],
                      ["pending", "paid"],
                    ],
                  },
                },
              ],
            },
      ),
    );

    const report = await checkDifferential(scenarios, {
      launch: launcherFor(program),
      contractHeader: "acme-version",
      currentLabel: "2026-09-20",
    });

    expect(report.differences.length).toBeGreaterThan(0);
    const status = report.differences.find((entry) => entry.pointer.endsWith("/status"));
    expect(status?.detail).toBe('was "succeeded", now "pending"');
  });

  /**
   * The fault that is not a shape change at all.
   *
   * Nothing in either specification moved, so there is no diff to close over
   * and no lens to test. The only way to notice is to ask the old build and
   * the new one the same question and read both answers.
   */
  it("catches a handler whose behaviour changed underneath an unchanged shape", async () => {
    const report = await checkDifferential(scenarios, {
      launch: launcherFor(
        await programFor(),
        () => new DelayedSettlementStore({ startClock: FIXED_CLOCK }),
      ),
      contractHeader: "acme-version",
      currentLabel: "2026-09-20",
    });

    expect(report.differences.length).toBeGreaterThan(0);
    const status = report.differences.find((entry) => entry.pointer === "/status");
    expect(status?.detail).toBe('was "succeeded", now "pending"');
  });

  /**
   * The other half of the division of labour, kept as a passing test.
   *
   * A wrong exponent is symmetric: the request is scaled up by the same factor
   * the response is scaled down by, so an old caller sends 49.99 and reads
   * 49.99 back and sees nothing wrong. What is wrong is the amount the provider
   * actually stored, and that is not on the old contract's surface at any point
   * in this scenario, so no amount of comparing the two builds finds it.
   *
   * The closure check is what catches it, before this ever runs: the old
   * contract declares `multipleOf: 0.01`, scaling by a thousand predicts a step
   * the new contract does not have, and the release is blocked there. Two
   * checks, two faults, neither able to cover for the other.
   */
  it("does NOT catch a scale exponent that changes what money means", async () => {
    const program = await programFor((changes) =>
      changes.map((change) =>
        change.id !== "chg_money_in_minor_units"
          ? change
          : {
              ...change,
              ops: [
                { op: "move", from: "/amount", to: "/amount_cents" },
                {
                  op: "convert",
                  path: "/amount_cents",
                  codec: { kind: "scale10", exponent: 3, onInexact: "reject" },
                },
              ],
            },
      ),
    );

    const report = await checkDifferential(scenarios, {
      launch: launcherFor(program),
      contractHeader: "acme-version",
      currentLabel: "2026-09-20",
    });

    // Invisible from the old contract's surface, exactly as described.
    expect(report.differences).toEqual([]);
  });

  /** So closure has to be the one that catches it, and it is. */
  it("leaves a wrong scale exponent to the closure check, which blocks it", async () => {
    const v2 = await loadContract(join(FIXTURE, "openapi/2026-03-01.json"), "2026-03-01");
    const head = await loadContract(join(FIXTURE, "openapi/head.json"), "head");

    const changes = (await loadPendingChanges(INVARIANT)).map((change) =>
      change.id !== "chg_money_in_minor_units"
        ? change
        : {
            ...change,
            ops: [
              { op: "move" as const, from: "/amount", to: "/amount_cents" },
              {
                op: "convert" as const,
                path: "/amount_cents",
                codec: {
                  kind: "scale10" as const,
                  exponent: 3,
                  onInexact: "reject" as const,
                },
              },
            ],
          },
    );

    const prediction = predictDocument(v2.document, head.document, changes);
    const entries = await diffDocuments(prediction.document, head.document);

    expect(breakingEntries(entries).length).toBeGreaterThan(0);
  });
});
