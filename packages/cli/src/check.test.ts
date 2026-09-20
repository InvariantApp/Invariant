/**
 * The release gate, against the real fixture provider.
 *
 * The blocking case matters more than the passing one. A gate that cannot be
 * made to fail is not a gate, so the Changes are removed one at a time and the
 * check has to notice each time.
 */
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oasdiffAvailable } from "@invariant/diff";
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
});
