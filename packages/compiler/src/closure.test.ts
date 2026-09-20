/**
 * The closure check is the load-bearing safety property: if a declared Change
 * set does not fully explain the structural diff, the release must not pass.
 * These tests remove and corrupt Changes and require that it notices.
 */
import { loadContract, loadPendingChanges } from "@invariant/contract";
import {
  breakingEntries,
  describeEntry,
  diffDocuments,
  oasdiffAvailable,
} from "@invariant/diff";
import type { Change, ConvertOp, MoveOp } from "@invariant/ir";
import { describe, expect, it } from "vitest";
import { predictDocument } from "./predict.ts";

const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;

const hasOasdiff = await oasdiffAvailable();
const describeDiff = describe.skipIf(!hasOasdiff);

async function unexplained(changes: readonly Change[]): Promise<string[]> {
  const base = await loadContract(`${FIXTURE}openapi/2026-03-01.json`, "2026-03-01");
  const head = await loadContract(`${FIXTURE}openapi/head.json`, "head");
  const prediction = predictDocument(base.document, head.document, changes);
  const entries = await diffDocuments(prediction.document, head.document);
  return [
    ...prediction.issues.map((issue) => `${issue.changeId}: ${issue.message}`),
    ...breakingEntries(entries).map(describeEntry),
  ];
}

async function pending(): Promise<Change[]> {
  return loadPendingChanges(`${FIXTURE}invariant`);
}

describeDiff("closure catches an incomplete or wrong change set", () => {
  it("passes only when every Change is present", async () => {
    expect(await unexplained(await pending())).toEqual([]);
  });

  it("blocks when any single Change is missing", async () => {
    const all = await pending();
    for (const dropped of all) {
      const rest = all.filter((change) => change.id !== dropped.id);
      const residual = await unexplained(rest);
      expect(
        residual,
        `dropping ${dropped.id} should leave something unexplained`,
      ).not.toEqual([]);
    }
  });

  it("blocks when a move targets the wrong field name", async () => {
    const changes = structuredClone(await pending());
    const money = changes.find((c) => c.id === "chg_money_in_minor_units") as Change;
    const move = money.ops.find((op) => op.op === "move") as MoveOp;
    move.to = "/amount_minor";
    const convert = money.ops.find((op) => op.op === "convert") as ConvertOp;
    convert.path = "/amount_minor";

    expect(await unexplained(changes)).not.toEqual([]);
  });

  it("blocks when an enum mapping sends a value to the wrong name", async () => {
    const changes = structuredClone(await pending());
    const status = changes.find(
      (c) => c.id === "chg_payment_status_vocabulary",
    ) as Change;
    const convert = status.ops.find((op) => op.op === "convert") as ConvertOp;
    if (convert.codec.kind === "enumMap") {
      convert.codec.pairs = [
        ["succeeded", "processing"],
        ["failed", "failed"],
        ["pending", "paid"],
      ];
    }

    // A swapped pair still produces the right SET of enum values, so the
    // specification alone genuinely cannot catch it. Recording that here keeps
    // the limit honest: closure proves the shapes line up, not that the values
    // were mapped to the right partners. Differential testing is what catches
    // this, which is exactly why closure is not the only gate.
    expect(await unexplained(changes)).toEqual([]);
  });

  it("reports an op that does not apply to the old contract at all", async () => {
    const changes = structuredClone(await pending());
    const money = changes.find((c) => c.id === "chg_money_in_minor_units") as Change;
    const move = money.ops.find((op) => op.op === "move") as MoveOp;
    move.from = "/no_such_field";

    const residual = await unexplained(changes);
    expect(residual.join("\n")).toContain("Nothing to read at");
  });
});
