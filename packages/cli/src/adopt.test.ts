/**
 * What it costs to start.
 *
 * The honest objection to this product is not technical: it is that a provider
 * is being asked to put someone else's middleware in their production request
 * path, maintain a new kind of file, and wire up CI, all before they have seen
 * anything work. That is a large thing to say yes to.
 *
 * So the first rung has to be worth standing on by itself. These tests pin down
 * that a provider with two specification files and nothing else gets a useful
 * answer, and that each further commitment is genuinely optional rather than
 * merely undocumented.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

/**
 * A provider who has adopted nothing.
 *
 * Two specifications and a five-line configuration. No Change files, no
 * compiled program, no runtime, no build commands, nothing in their service.
 */
async function bareProvider(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-adopt-"));
  await mkdir(join(scratch, "openapi"), { recursive: true });
  await mkdir(join(scratch, "invariant/changes"), { recursive: true });

  for (const name of ["2026-03-01.json", "head.json"]) {
    await cp(join(FIXTURE, "openapi", name), join(scratch, "openapi", name));
  }

  await writeFile(
    join(scratch, "invariant.yaml"),
    `api: acme-payments
spec:
  current: openapi/head.json
  currentLabel: "2026-09-20"
  released:
    "2026-03-01": openapi/2026-03-01.json
`,
    "utf8",
  );

  return scratch;
}

describe.skipIf(!hasOasdiff)("the first rung", () => {
  it("tells a provider what they are about to break, having installed nothing", async () => {
    const root = await bareProvider();
    const report = await check(await loadConfig(join(root, "invariant.yaml")));

    // Blocked, which is the point: it found real breakage nobody declared.
    expect(report.result).toBe("block");

    const unexplained = report.steps.flatMap((step) => step.unexplained);
    expect(unexplained.length).toBeGreaterThan(20);

    // Not a count, an inventory. Each entry names the operation and the field,
    // which is the thing a provider cannot easily work out for themselves and
    // the reason this is worth running before committing to anything else.
    const rendered = renderReport(report);
    expect(rendered).toContain("POST /v1/payments");
    expect(rendered).toContain("amount");
    expect(rendered).toContain("capture_method");
  });

  it("needs no runtime, no adapter and no build commands to say it", async () => {
    const root = await bareProvider();
    const config = await loadConfig(join(root, "invariant.yaml"));

    // The three commitments that are genuinely large are all absent here, and
    // the tool neither requires them nor pretends it checked them.
    expect(config.build).toBeUndefined();

    const report = await check(config);
    const kinds = new Set(report.evidence.map((entry) => entry.kind));
    expect(kinds).toContain("E2-closure");
    expect(kinds).not.toContain("E6-differential");

    // And it says so rather than letting a reader assume the layers that need
    // a running service were run and passed.
    expect(renderReport(report)).not.toContain("the old build and the new build");
  });

  it("passes once the Changes are written, still with nothing installed", async () => {
    const root = await bareProvider();
    await cp(join(FIXTURE, "invariant/changes"), join(root, "invariant/changes"), {
      recursive: true,
    });

    const report = await check(await loadConfig(join(root, "invariant.yaml")));

    // The whole first rung: declare what changed, and the gate agrees the
    // declarations explain it. No middleware has been installed at any point.
    expect(report.result).toBe("pass");
    expect(report.steps.flatMap((step) => step.unexplained)).toEqual([]);
    expect(report.program).toBeDefined();
  });

  it("warns rather than guesses when the provider has not named their contract", async () => {
    const root = await bareProvider();
    await writeFile(
      join(root, "invariant.yaml"),
      `api: acme-payments
spec:
  current: openapi/head.json
  released:
    "2026-03-01": openapi/2026-03-01.json
`,
      "utf8",
    );

    const report = await check(await loadConfig(join(root, "invariant.yaml")));

    // Naming the contract after today's date makes the build depend on the day
    // it ran. A provider should find that out from a warning, not from two
    // artifacts that will not match.
    expect(report.warnings.join("\n")).toContain("spec.currentLabel");
  });
});
