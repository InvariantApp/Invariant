/**
 * Scaling money is the one op where a wrong constant produces a schema that
 * still looks plausible. These tests pin down exactly which wrong exponents the
 * compiler can reject on its own, and say plainly where it needs help.
 */
import { loadContract, loadPendingChanges } from "@invariant-app/contract";
import {
  breakingEntries,
  describeEntry,
  diffDocuments,
  oasdiffAvailable,
} from "@invariant-app/diff";
import type { Change, ConvertOp } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { predictDocument } from "./predict.ts";

const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;
const hasOasdiff = await oasdiffAvailable();
const describeDiff = describe.skipIf(!hasOasdiff);

async function residualFor(exponent: number): Promise<string[]> {
  const changes = structuredClone(
    await loadPendingChanges(`${FIXTURE}invariant`),
  ) as Change[];
  const money = changes.find((c) => c.id === "chg_money_in_minor_units") as Change;
  const convert = money.ops.find((op) => op.op === "convert") as ConvertOp;
  if (convert.codec.kind === "scale10") convert.codec.exponent = exponent;

  const base = await loadContract(`${FIXTURE}openapi/2026-03-01.json`, "2026-03-01");
  const head = await loadContract(`${FIXTURE}openapi/head.json`, "head");
  const prediction = predictDocument(base.document, head.document, changes);
  const entries = await diffDocuments(prediction.document, head.document);
  return [
    ...prediction.issues.map((i) => `${i.changeId}: ${i.message}`),
    ...breakingEntries(entries).map(describeEntry),
  ];
}

describeDiff("scale exponent checking", () => {
  it("accepts the exponent the declared precision implies", async () => {
    expect(await residualFor(2)).toEqual([]);
  });

  it("rejects an exponent too small to make the value an integer", async () => {
    const residual = (await residualFor(1)).join("\n");
    expect(residual).toContain("cannot be an integer");
  });

  it("rejects an exponent that would leave a coarser step than the contract states", async () => {
    const residual = (await residualFor(3)).join("\n");
    expect(residual).not.toBe("");
    expect(residual).toMatch(/multiple|amount_cents/i);
  });
});
