/**
 * The laws, on parameter-scoped Changes: what an old caller may send has to
 * reach the provider as something the new contract accepts.
 */
import { predictDocument } from "@invariant/compiler";
import type { OpenApiDocument } from "@invariant/contract";
import { type Change, parseChange } from "@invariant/ir";
import { describe, expect, it } from "vitest";
import { checkLaws } from "./laws.ts";

function contract(parameters: unknown[]): OpenApiDocument {
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          parameters,
          responses: { "200": { description: "ok" } },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const sort = (values: string[], name = "sort") => ({
  name,
  in: "query",
  schema: { type: "string", enum: values },
});

const change = (ops: unknown[]): Change =>
  parseChange({
    irVersion: 1,
    id: "chg_sort",
    summary: "sort",
    scopes: [{ operation: "listItems", location: "query" }],
    ops,
  });

function laws(before: OpenApiDocument, after: OpenApiDocument, changes: Change[]) {
  const predicted = predictDocument(before, after, changes);
  expect(predicted.issues).toEqual([]);
  return checkLaws(before, predicted.document, changes, { runs: 200, seed: 7 });
}

describe("a parameter-scoped Change", () => {
  it("holds when every value an old caller sends lands in the new vocabulary", () => {
    const before = contract([sort(["asc", "desc"])]);
    const after = contract([sort(["ascending", "descending"])]);
    const report = laws(before, after, [
      change([
        {
          op: "convert",
          path: "/sort",
          codec: {
            kind: "enumMap",
            pairs: [
              ["asc", "ascending"],
              ["desc", "descending"],
            ],
          },
        },
      ]),
    ]);
    expect(report.failures).toEqual([]);
    expect(report.evidence.map((entry) => entry.subject)).toContain(
      "listItems parameters",
    );
  });

  it("fails, with the value, when a renamed parameter's default is outside the new vocabulary", () => {
    const before = contract([]);
    const after = contract([
      {
        name: "order",
        in: "query",
        required: true,
        schema: { type: "string", enum: ["asc"] },
      },
    ]);
    const report = laws(before, after, [
      change([{ op: "add", path: "/order", value: "newest" }]),
    ]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.detail).toContain('"newest"');
  });

  it("fails when an old caller can leave out what the new contract requires", () => {
    const before = contract([
      { name: "limit", in: "query", schema: { type: "integer" } },
    ]);
    const after = contract([
      { name: "page_size", in: "query", required: true, schema: { type: "integer" } },
    ]);
    const renamed = change([{ op: "move", from: "/limit", to: "/page_size" }]);
    // The rename alone predicts page_size optional, so closure would report
    // the requiredness; the law reports what an old caller would hit.
    const predicted = predictDocument(before, after, [renamed]);
    const required = structuredClone(predicted.document);
    const list = (
      required["paths"] as Record<
        string,
        Record<string, { parameters: Record<string, unknown>[] }>
      >
    )["/items"]?.["get"];
    if (list?.parameters[0]) list.parameters[0]["required"] = true;
    const report = checkLaws(before, required, [renamed], { runs: 200, seed: 7 });
    expect(report.failures[0]?.detail).toContain("required by the new contract");
  });
});
