import {
  loadContract,
  loadPendingChanges,
  loadReleaseStep,
} from "@invariant-app/contract";
import {
  breakingEntries,
  describeEntry,
  diffDocuments,
  oasdiffAvailable,
} from "@invariant-app/diff";
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

describe("a route onto an operation the contract already serves", () => {
  const operation = (id: string) => ({
    operationId: id,
    responses: { "200": { description: "ok" } },
  });
  const before = {
    openapi: "3.1.0",
    info: { title: "points", version: "1" },
    paths: {
      "/points/search": { post: operation("search") },
      "/points/query": { post: operation("query") },
    },
  };
  const after = {
    ...before,
    paths: { "/points/query": { post: operation("query") } },
  };

  it("is refused, and the operation already there is still what closure compares", () => {
    const prediction = predictDocument(before, after, [
      {
        irVersion: 1,
        id: "chg_search_became_query",
        summary: "Search is now query.",
        ops: [
          {
            op: "route",
            from: { method: "post", path: "/points/search" },
            to: { method: "post", path: "/points/query" },
          },
        ],
      },
    ]);
    expect(prediction.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining(
        "which this contract already serves as an operation of its own",
      ),
    ]);
    expect(prediction.document["paths"]).toEqual(after.paths);
  });
});
