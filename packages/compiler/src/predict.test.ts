import { loadContract, loadPendingChanges, loadReleaseStep } from "@invariant/contract";
import {
  breakingEntries,
  describeEntry,
  diffDocuments,
  oasdiffAvailable,
} from "@invariant/diff";
import { describe, expect, it } from "vitest";
import { predictDocument } from "./predict.ts";

const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;
const openapi = (name: string) => `${FIXTURE}openapi/${name}.json`;

const hasOasdiff = await oasdiffAvailable();
const describeDiff = describe.skipIf(!hasOasdiff);

describeDiff("closure", () => {
  it("the declared Changes fully explain 2026-01-15 -> 2026-03-01", async () => {
    const base = await loadContract(openapi("2026-01-15"), "2026-01-15");
    const next = await loadContract(openapi("2026-03-01"), "2026-03-01");
    const step = await loadReleaseStep(`${FIXTURE}invariant`, "2026-03-01");

    const prediction = predictDocument(base.document, next.document, step.changes);
    expect(prediction.issues).toEqual([]);

    const entries = await diffDocuments(prediction.document, next.document);
    expect(breakingEntries(entries).map(describeEntry)).toEqual([]);
  });

  it("the pending Changes fully explain 2026-03-01 -> head", async () => {
    const base = await loadContract(openapi("2026-03-01"), "2026-03-01");
    const head = await loadContract(openapi("head"), "head");
    const changes = await loadPendingChanges(`${FIXTURE}invariant`);

    const prediction = predictDocument(base.document, head.document, changes);
    expect(prediction.issues).toEqual([]);

    const entries = await diffDocuments(prediction.document, head.document);
    expect(breakingEntries(entries).map(describeEntry)).toEqual([]);
  });
});
