/**
 * The release gate, against the real fixture provider.
 *
 * The blocking case matters more than the passing one. A gate that cannot be
 * made to fail is not a gate, so the Changes are removed one at a time and the
 * check has to notice each time.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oasdiffAvailable } from "@invariant/diff";
import { createRuntime } from "@invariant/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { check, renderReport } from "./check.ts";
import { loadConfig } from "./config.ts";

const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;
const hasOasdiff = await oasdiffAvailable();

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A throwaway copy of the provider, so a test can edit its Changes. */
async function copyProvider(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-gate-"));
  for (const entry of ["invariant.yaml", "invariant", "openapi"]) {
    await cp(join(FIXTURE, entry), join(scratch, entry), { recursive: true });
  }
  return scratch;
}

describe.skipIf(!hasOasdiff)("the release gate", () => {
  it("passes when the declared Changes explain the release", async () => {
    const report = await check(await loadConfig(`${FIXTURE}invariant.yaml`));
    expect(report.result).toBe("pass");
    expect(report.steps.flatMap((step) => step.unexplained)).toEqual([]);
    expect(report.program).toBeDefined();
    expect(Object.keys(report.program?.contracts ?? {})).toEqual([
      "2026-01-15",
      "2026-03-01",
    ]);
  });

  it("blocks when any single Change is missing", async () => {
    const root = await copyProvider();
    const pending = [
      "chg_money_in_minor_units",
      "chg_capture_method",
      "chg_payment_status_vocabulary",
    ];

    for (const dropped of pending) {
      const path = join(root, "invariant/changes", `${dropped}.yaml`);
      const saved = join(root, `${dropped}.saved`);
      await cp(path, saved);
      await rm(path);

      const report = await check(await loadConfig(join(root, "invariant.yaml")));
      expect(report.result, `dropping ${dropped} should block`).toBe("block");
      expect(report.steps.at(-1)?.unexplained.length).toBeGreaterThan(0);
      // A blocked release compiles no program, because an adapter built from
      // Changes that do not explain the release would serve the old contract
      // incorrectly.
      expect(report.program).toBeUndefined();

      await cp(saved, path);
    }
  });

  it("blocks when a Change does not apply to the old contract", async () => {
    const root = await copyProvider();
    await writeFile(
      join(root, "invariant/changes/chg_money_in_minor_units.yaml"),
      `irVersion: 1
id: chg_money_in_minor_units
summary: A change that names a field the old contract never had.
scopes:
  - schema: "#/components/schemas/Payment"
ops:
  - op: move
    from: /no_such_field
    to: /amount_cents
`,
      "utf8",
    );

    const report = await check(await loadConfig(join(root, "invariant.yaml")));
    expect(report.result).toBe("block");
    expect(report.steps.at(-1)?.issues.join("\n")).toContain("Nothing to read at");
  });

  /**
   * A query parameter renamed between releases, end to end.
   *
   * This used to be the case that proved the gate blocks what the runtime
   * cannot serve: the rename closed, and the program only rewrote bodies, so
   * an old caller's `?limit=` would have reached the handler untouched. The
   * request envelope serves it, so now the gate passes it and the program it
   * compiles rewrites the query string an old caller actually sends.
   */
  it("serves a query parameter renamed between releases", async () => {
    const root = await copyProvider();
    const head = join(root, "openapi/head.json");
    const document = JSON.parse(await readFile(head, "utf8"));
    const list = document.paths["/v1/payments"].get;
    list.parameters[0].name = "page_size";
    await writeFile(head, JSON.stringify(document, null, 2), "utf8");
    await writeFile(
      join(root, "invariant/changes/chg_page_size.yaml"),
      `irVersion: 1
id: chg_page_size
summary: The list page size parameter is called page_size.
scopes:
  - operation: payments.list
    location: query
ops:
  - op: move
    from: /limit
    to: /page_size
assertions:
  same_concept: true
  side_effects_unchanged: true
`,
      "utf8",
    );

    const report = await check(await loadConfig(join(root, "invariant.yaml")));

    expect(report.steps.flatMap((step) => step.unexplained)).toEqual([]);
    expect(report.result).not.toBe("block");
    expect(report.program).toBeDefined();

    // Every contract before this release reaches the handler as page_size.
    const runtime = createRuntime({
      program: report.program,
      identity: [{ kind: "default", label: "2026-01-15" }],
    });
    const site = runtime.siteFor("2026-01-15", "GET", "/v1/payments");
    expect(site?.envelope).toBeDefined();
    if (!site) return;
    const adapted = await runtime.adaptRequest(
      site,
      new Request("https://api.example.com/v1/payments?limit=5&starting_after=pay_1"),
      {
        path: "/v1/payments",
        search: "?limit=5&starting_after=pay_1",
        headers: new Headers(),
      },
      { contract: "2026-01-15", operation: "payments.list" },
    );
    expect(adapted.search).toBe("?starting_after=pay_1&page_size=5");
  });

  it("warns when a Change does not say whether side effects changed", async () => {
    const root = await copyProvider();
    await writeFile(
      join(root, "invariant/changes/chg_payment_status_vocabulary.yaml"),
      `irVersion: 1
id: chg_payment_status_vocabulary
summary: Payment status became paid / failed / processing.
scopes:
  - schema: "#/components/schemas/Payment"
ops:
  - op: convert
    path: /status
    codec:
      kind: enumMap
      pairs:
        - ["succeeded", "paid"]
        - ["failed", "failed"]
        - ["pending", "processing"]
`,
      "utf8",
    );

    const report = await check(await loadConfig(join(root, "invariant.yaml")));
    expect(report.result).toBe("warn");
    expect(report.warnings.join("\n")).toContain("side_effects_unchanged");
  });

  it("renders a report a person can act on", async () => {
    const report = await check(await loadConfig(`${FIXTURE}invariant.yaml`));
    const rendered = renderReport(report);
    expect(rendered).toContain("acme-payments");
    expect(rendered).toContain(
      "Historical contracts still served: 2026-01-15, 2026-03-01",
    );
    expect(rendered).toContain("Release status: PASS");
  });
  it("reports what each layer actually checked, not just a verdict", async () => {
    const report = await check(await loadConfig(`${FIXTURE}invariant.yaml`));

    const kinds = new Set(report.evidence.map((entry) => entry.kind));
    expect(kinds).toContain("E2-closure");
    expect(kinds).toContain("E4-laws");
    expect(kinds).toContain("E5-chain");
    // Every record names the inputs it ran against, so a stale one cannot be
    // passed off as evidence about a later release.
    expect(
      report.evidence.every((entry) => entry.inputsDigest.startsWith("sha256:")),
    ).toBe(true);

    const rendered = renderReport(report);
    expect(rendered).toContain("What was checked:");
    expect(rendered).toContain("the Changes explain the whole breaking diff");
    expect(rendered).toContain("round trip on");
  });

  /**
   * Closure is not the only thing that can block.
   *
   * This Change closes perfectly. The predicted specification is identical to
   * the real one, because an `add` takes the field's shape from the new
   * contract and only the default lives in the Change. The default is the part
   * that is wrong, and it is in neither document for a comparison to find. Run
   * it and every request from a caller who predates the field arrives at the
   * provider's own handler carrying a value that handler will refuse.
   */
  it("blocks on a default the new contract does not allow, which closure accepts", async () => {
    const root = await copyProvider();
    await writeFile(
      join(root, "invariant/changes/chg_capture_method.yaml"),
      `irVersion: 1
id: chg_capture_method
summary: Capture method became explicit.
scopes:
  - schema: "#/components/schemas/PaymentCreateParams"
  - schema: "#/components/schemas/Payment"
ops:
  - op: add
    path: /capture_method
    value: auto
assertions:
  same_concept: true
  side_effects_unchanged: true
  loss_acknowledged: true
`,
      "utf8",
    );

    const report = await check(await loadConfig(join(root, "invariant.yaml")));

    // Closure is satisfied: nothing in the diff is left unexplained.
    expect(report.steps.flatMap((step) => step.unexplained)).toEqual([]);
    const closure = report.evidence.filter((entry) => entry.kind === "E2-closure");
    expect(closure.every((entry) => entry.result !== "fail")).toBe(true);

    // The laws are not, and the gate blocks.
    expect(report.result).toBe("block");
    expect(report.problems.join("\n")).toContain('"auto" is not one of');
    expect(report.program).toBeUndefined();
    expect(renderReport(report)).toContain("a verification layer found something");
  });
});
