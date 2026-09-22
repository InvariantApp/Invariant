/**
 * Releasing, against a throwaway copy of the real provider.
 *
 * A release moves files and mints a name, so it is the one command where doing
 * it twice, or doing it half way, would leave a repository someone has to
 * repair by hand. Those are the cases here.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigningKey, openBundle } from "@invariant-app/bundle";
import {
  listReleasedLabels,
  loadPendingChanges,
  loadReleaseStep,
} from "@invariant-app/contract";
import { oasdiffAvailable } from "@invariant-app/diff";
import { afterEach, describe, expect, it } from "vitest";
import { check, renderReport } from "./check.ts";
import { loadConfig } from "./config.ts";
import { mintLabel, ReleaseError, release } from "./release.ts";

const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;
const hasOasdiff = await oasdiffAvailable();

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function copyProvider(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-release-"));
  for (const entry of ["invariant.yaml", "invariant", "openapi"]) {
    await cp(join(FIXTURE, entry), join(scratch, entry), { recursive: true });
  }
  return scratch;
}

const SOURCE = { repo: "acme/payments-api", commit: "c0ffee", pr: 482 };

describe("minting a label", () => {
  it("uses the date when it is free", () => {
    expect(mintLabel("2026-09-20", ["2026-01-15"])).toBe("2026-09-20");
  });

  it("does not overwrite an earlier release on the same day", () => {
    // Two breaking releases in one day is unusual and not forbidden. Silently
    // reusing the label would leave two different contracts with one name, and
    // every consumer pinned to it would get whichever won.
    expect(mintLabel("2026-09-20", ["2026-09-20"])).toBe("2026-09-20.2");
    expect(mintLabel("2026-09-20", ["2026-09-20", "2026-09-20.2"])).toBe("2026-09-20.3");
  });
});

describe.skipIf(!hasOasdiff)("releasing", () => {
  it("says what it would do and writes nothing", async () => {
    const root = await copyProvider();
    const config = await loadConfig(join(root, "invariant.yaml"));

    const result = await release(config, { source: SOURCE, dryRun: true });

    expect(result.label).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(result.digest).toMatch(/^sha256:/);
    expect(result.bundle.changes).toHaveLength(3);
    expect(result.wrote.length).toBeGreaterThan(0);

    // The pending Changes are still pending, and no released step appeared.
    expect(await loadPendingChanges(config.invariantDir)).toHaveLength(3);
    expect(await listReleasedLabels(config.invariantDir)).toEqual(["2026-03-01"]);
  });

  it("refuses to publish without a signing key", async () => {
    const root = await copyProvider();
    const config = await loadConfig(join(root, "invariant.yaml"));

    await expect(release(config, { source: SOURCE })).rejects.toThrow(
      /INVARIANT_SIGNING_KEY/,
    );
  });

  it("publishes a bundle that opens with the publisher's key", async () => {
    const root = await copyProvider();
    const config = await loadConfig(join(root, "invariant.yaml"));
    const { privateKeyPem, publicKeyPem } = generateSigningKey();

    const result = await release(config, {
      source: SOURCE,
      signingKeyPem: privateKeyPem,
    });

    const envelope = JSON.parse(
      await readFile(
        join(config.invariantDir, "bundles", `${result.label}.dsse.json`),
        "utf8",
      ),
    ) as Parameters<typeof openBundle>[0];

    const opened = openBundle(envelope, [publicKeyPem]);
    expect(opened.digest).toBe(result.digest);
    expect(opened.bundle.from.label).toBe("2026-03-01");
    expect(opened.bundle.to.label).toBe(result.label);
    expect(opened.bundle.source.commit).toBe("c0ffee");

    // Every layer that ran is in the bundle, so a consumer receiving it can
    // see what was proved rather than taking the signature as the whole story.
    expect(opened.bundle.evidence.length).toBeGreaterThan(0);
    expect(new Set(opened.bundle.evidence.map((entry) => entry.kind))).toContain(
      "E4-laws",
    );
  });

  it("moves the pending Changes into the released step", async () => {
    const root = await copyProvider();
    const config = await loadConfig(join(root, "invariant.yaml"));
    const { privateKeyPem } = generateSigningKey();

    const result = await release(config, {
      source: SOURCE,
      signingKeyPem: privateKeyPem,
    });

    // Nothing pending means the next pull request's diff starts from the
    // contract this one just published, which is the whole reason for moving
    // them rather than copying.
    expect(await loadPendingChanges(config.invariantDir)).toEqual([]);
    expect(await listReleasedLabels(config.invariantDir)).toEqual([
      "2026-03-01",
      result.label,
    ]);

    // The property that matters is that the step this wrote can be read back,
    // in the order it was written. A label is quoted because it looks like a
    // date, and a parser that resolved it as one would hand back a timestamp
    // where every caller expects a string.
    const order = await readFile(
      join(config.invariantDir, "released", result.label, "order.yaml"),
      "utf8",
    );
    expect(order).toContain(`parent: "2026-03-01"`);

    const step = await loadReleaseStep(config.invariantDir, result.label);
    expect(step.manifest.parent).toBe("2026-03-01");
    expect(step.manifest.contract).toBe(result.label);
    expect(step.changes.map((change) => change.id)).toEqual([
      "chg_capture_method",
      "chg_money_in_minor_units",
      "chg_payment_status_vocabulary",
    ]);
  });

  /**
   * A release has to leave a repository the gate can keep working in.
   *
   * It used to mint its label from the clock and ignore spec.currentLabel, so
   * the program the gate compiled named the current contract one thing and
   * the signed bundle another. A caller sending the published label got
   * "unknown contract". It also never recorded the new contract in
   * invariant.yaml, so the next check compared the old contract to head with
   * no Changes, and blocked on everything this release had just explained.
   */
  it("leaves a repository whose next check passes, under the label it published", async () => {
    const root = await copyProvider();
    const config = await loadConfig(join(root, "invariant.yaml"));
    const { privateKeyPem } = generateSigningKey();

    const result = await release(config, {
      source: SOURCE,
      signingKeyPem: privateKeyPem,
    });

    // The name the provider gave the contract being built is the one released.
    expect(result.label).toBe("2026-09-20");
    expect(result.bundle.to.label).toBe(result.report.program?.currentLabel);

    const again = await check(await loadConfig(join(root, "invariant.yaml")));
    expect(again.result, renderReport(again)).not.toBe("block");
    expect(again.program?.currentLabel).toBe("2026-09-20");
    expect(Object.keys(again.program?.contracts ?? {}).sort()).toEqual([
      "2026-01-15",
      "2026-03-01",
    ]);

    // Comments the provider wrote survive the edit.
    const yaml = await readFile(join(root, "invariant.yaml"), "utf8");
    expect(yaml).toContain("# How a request declares which contract it expects.");
    expect(yaml).toContain(`"2026-09-20": invariant/contracts/2026-09-20.openapi.json`);
  });

  it("refuses to build a new contract under a label that is already released", async () => {
    const root = await copyProvider();
    const config = await loadConfig(join(root, "invariant.yaml"));
    const { privateKeyPem } = generateSigningKey();
    await release(config, { source: SOURCE, signingKeyPem: privateKeyPem });

    // The next pull request declares a Change but forgets to name the contract
    // it builds, so it would be compiled under the label just published.
    await writeFile(
      join(root, "invariant/changes/chg_next.yaml"),
      `irVersion: 1
id: chg_next
summary: Something else changed.
scopes:
  - schema: "#/components/schemas/Payment"
ops:
  - op: move
    from: /currency
    to: /currency_code
`,
      "utf8",
    );
    await expect(check(await loadConfig(join(root, "invariant.yaml")))).rejects.toThrow(
      /already released/,
    );
  });

  it("refuses a second release when nothing is pending", async () => {
    const root = await copyProvider();
    const config = await loadConfig(join(root, "invariant.yaml"));
    const { privateKeyPem } = generateSigningKey();

    await release(config, { source: SOURCE, signingKeyPem: privateKeyPem });

    await expect(
      release(config, { source: SOURCE, signingKeyPem: privateKeyPem }),
    ).rejects.toThrow(ReleaseError);
  });

  it("refuses to publish a release the gate blocked", async () => {
    const root = await copyProvider();
    await rm(join(root, "invariant/changes/chg_money_in_minor_units.yaml"));
    const config = await loadConfig(join(root, "invariant.yaml"));
    const { privateKeyPem } = generateSigningKey();

    // A signature on a blocked release would say "this is what we shipped"
    // about something the gate said must not ship.
    await expect(
      release(config, { source: SOURCE, signingKeyPem: privateKeyPem }),
    ).rejects.toThrow(/blocked this release/);
  });

  it("produces the same digest from the same inputs", async () => {
    const first = await copyProvider();
    const firstResult = await release(await loadConfig(join(first, "invariant.yaml")), {
      source: SOURCE,
      dryRun: true,
    });
    await rm(first, { recursive: true, force: true });

    const second = await copyProvider();
    const secondResult = await release(await loadConfig(join(second, "invariant.yaml")), {
      source: SOURCE,
      dryRun: true,
    });

    // Two machines, two checkouts, one digest. Without this a published bundle
    // could only be trusted, never checked.
    expect(secondResult.digest).toBe(firstResult.digest);
  });

  it("notices when a Change was edited between builds", async () => {
    const root = await copyProvider();
    const before = await release(await loadConfig(join(root, "invariant.yaml")), {
      source: SOURCE,
      dryRun: true,
    });

    const path = join(root, "invariant/changes/chg_money_in_minor_units.yaml");
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace("Money crosses", "Money now crosses"), "utf8");

    const after = await release(await loadConfig(join(root, "invariant.yaml")), {
      source: SOURCE,
      dryRun: true,
    });

    expect(after.digest).not.toBe(before.digest);
  });
  /**
   * E8 is the weakest-looking record in a bundle and in some ways the most
   * important: every other kind says a machine checked something, and this one
   * says a person who could have said no did not.
   */
  it("records who confirmed each Change, and says so when nobody did", async () => {
    const root = await copyProvider();
    const path = join(root, "invariant/changes/chg_capture_method.yaml");
    await writeFile(
      path,
      `${await readFile(path, "utf8")}provenance:
  confirmed_by:
    kind: provider-merge
    commit: 9f2c1a4bb0
    reviewer: dana
`,
      "utf8",
    );

    const config = await loadConfig(join(root, "invariant.yaml"));
    const result = await release(config, { source: SOURCE, dryRun: true });

    const merges = result.bundle.evidence.filter((entry) => entry.kind === "E8-merge");
    expect(merges).toHaveLength(3);

    const confirmed = merges.find((entry) => entry.subject === "chg_capture_method");
    expect(confirmed?.result).toBe("pass");
    expect(confirmed?.summary).toContain("merged in 9f2c1a4");
    expect(confirmed?.summary).toContain("dana");

    // A Change with no record is marked skipped rather than left out. A
    // missing record and a passing one must not look the same to whoever
    // reads the bundle.
    const unconfirmed = merges.filter((entry) => entry.result === "skipped");
    expect(unconfirmed).toHaveLength(2);
    expect(unconfirmed[0]?.summary).toContain("nobody is recorded");
  });
});
