/**
 * A response vocabulary that grew, from the draft to the gate.
 *
 * `invariant propose --write` drafts the decision with a suggestion filled in,
 * and the gate refuses it until a person acknowledges the loss a fold
 * declares. A suggestion must never pass as a decision on its own.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oasdiffAvailable } from "@invariant/diff";
import { afterEach, describe, expect, it } from "vitest";
import { check, renderReport } from "./check.ts";
import { loadConfig } from "./config.ts";
import { renderProposals, runPropose } from "./propose.ts";

const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;
const hasOasdiff = await oasdiffAvailable();

let scratch: string | undefined;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe.skipIf(!hasOasdiff)("a vocabulary that grew", () => {
  it("is drafted with a suggestion beside a placeholder, and blocked until someone answers", async () => {
    scratch = await mkdtemp(join(tmpdir(), "invariant-decision-"));
    for (const entry of ["invariant.yaml", "invariant", "openapi"]) {
      await cp(join(FIXTURE, entry), join(scratch, entry), { recursive: true });
    }
    const head = join(scratch, "openapi/head.json");
    const document = JSON.parse(await readFile(head, "utf8"));
    // Payment's status is already decided in the fixture; Refund's is not.
    document.components.schemas.Refund.properties.status.enum.push("succeeded_partially");
    await writeFile(head, JSON.stringify(document, null, 2), "utf8");

    const config = await loadConfig(join(scratch, "invariant.yaml"));
    const drafted = await runPropose(config, { write: true, offline: true });
    const decision = drafted.decisions.find(
      (entry) => entry.schema === "Refund" && entry.kind === "vocabulary",
    );
    expect(decision?.kind === "vocabulary" && decision.suggested.fold).toEqual([
      ["succeeded_partially", "succeeded"],
    ]);
    expect(renderProposals(drafted)).toContain("show succeeded_partially as succeeded?");
    const path = drafted.written.find((file) => file.endsWith("_vocabulary.yaml"));
    expect(path).toBeDefined();
    const text = await readFile(path as string, "utf8");
    expect(text.startsWith("# DECISION NEEDED")).toBe(true);

    const blocked = await check(await loadConfig(join(scratch, "invariant.yaml")));
    expect(blocked.result).toBe("block");

    // A person reads the suggestion, answers, and acknowledges the loss.
    expect(text).toContain("succeeded_partially: succeeded, suggested");
    await writeFile(
      path as string,
      `${text.replace("[succeeded_partially, CHOOSE_ONE]", "[succeeded_partially, succeeded]").replace("- succeeded_partially\n          - CHOOSE_ONE", "- succeeded_partially\n          - succeeded")}assertions:\n  loss_acknowledged: true\n  same_concept: true\n  side_effects_unchanged: true\n`,
      "utf8",
    );
    const passed = await check(await loadConfig(join(scratch, "invariant.yaml")));
    expect(passed.result, renderReport(passed)).not.toBe("block");
  });
});

describe.skipIf(!hasOasdiff)("a value the specification does not give", () => {
  it("is drafted with a placeholder a text field would accept, and still blocked until answered", async () => {
    scratch = await mkdtemp(join(tmpdir(), "invariant-value-decision-"));
    for (const entry of ["invariant.yaml", "invariant", "openapi"]) {
      await cp(join(FIXTURE, entry), join(scratch, entry), { recursive: true });
    }
    const head = join(scratch, "openapi/head.json");
    const document = JSON.parse(await readFile(head, "utf8"));
    // On a schema nothing else changed in, so it cannot be a rename.
    const method = document.components.schemas.PaymentMethod;
    method.properties.network = { type: "string" };
    method.required.push("network");
    await writeFile(head, JSON.stringify(document, null, 2), "utf8");

    const config = await loadConfig(join(scratch, "invariant.yaml"));
    const drafted = await runPropose(config, { write: true, offline: true });
    const decision = drafted.decisions.find((entry) => entry.field === "network");
    expect(decision).toMatchObject({ kind: "value", op: { op: "add" } });
    expect(renderProposals(drafted)).toContain("Answer with a string.");
    const path = drafted.written.find((file) => file.endsWith("_network_added.yaml"));
    const text = await readFile(path as string, "utf8");
    expect(text.startsWith("# DECISION NEEDED")).toBe(true);
    expect(text).toContain("value: CHOOSE_ONE");

    // The placeholder is a string, so only the gate's own check stops it.
    const blocked = await check(await loadConfig(join(scratch, "invariant.yaml")));
    expect(blocked.result).toBe("block");
    expect(renderReport(blocked)).toMatch(/decision nobody has made yet/);

    await writeFile(
      path as string,
      text.replace("value: CHOOSE_ONE", "value: ACME"),
      "utf8",
    );
    const passed = await check(await loadConfig(join(scratch, "invariant.yaml")));
    expect(passed.result, renderReport(passed)).not.toBe("block");
  });
});
