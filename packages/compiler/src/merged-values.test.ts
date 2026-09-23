/**
 * Two old values that became one, on a field used both ways.
 *
 * Plaid stopped accepting a report version old callers may still send, on a
 * schema its responses carry too. A decision sends the version that went as
 * one that remains; on the way back the one that remains is shown as itself,
 * since the API can no longer produce the one that went.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { parseChange } from "@invariant-app/ir";
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { derive } from "./derive.ts";
import { predictDocument } from "./predict.ts";

const doc = (versions: string[]): OpenApiDocument =>
  ({
    openapi: "3.0.3",
    info: { title: "reports", version: "1" },
    paths: {
      "/reports": {
        post: {
          operationId: "createReport",
          requestBody: {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Report" } },
            },
          },
          responses: {
            "200": {
              description: "made",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Report" } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Report: {
          type: "object",
          properties: { version: { type: "string", enum: versions } },
        },
      },
    },
  }) as unknown as OpenApiDocument;

const before = doc(["3.00", "4.00", "5.00"]);
const after = doc(["4.00", "5.00"]);
const change = parseChange({
  irVersion: 1,
  id: "chg_report_version",
  summary: "3.00 is no longer accepted.",
  scopes: [{ schema: "#/components/schemas/Report" }],
  ops: [
    {
      op: "convert",
      path: "/version",
      codec: {
        kind: "enumMap",
        // As the decision is drafted: the values that remain, then the one
        // that went.
        pairs: [
          ["4.00", "4.00"],
          ["5.00", "5.00"],
          ["3.00", "4.00"],
        ],
      },
    },
  ],
});

describe("two old values that became one, on a field used both ways (Plaid)", () => {
  it("predicts the new contract and is a declared loss", () => {
    const prediction = predictDocument(before, after, [change]);
    expect(prediction.issues).toEqual([]);
    const report = (
      prediction.document as unknown as {
        components: {
          schemas: { Report: { properties: { version: { enum: string[] } } } };
        };
      }
    ).components.schemas.Report;
    expect(report.properties.version.enum).toEqual(["4.00", "5.00"]);
    expect(derive(change).runtime).toBe("declared-lossy");
  });

  it("sends the value that went as the one that remains, and shows that one as itself", () => {
    const { program, issues } = chainProgram("reports", "v2", "sha256:2", [
      { label: "v2", parent: "v1", from: before, to: after, changes: [change] },
    ]);
    expect(issues).toEqual([]);
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "v1" }],
    });
    const site = runtime.siteFor("v1", "post", "/reports");
    expect(site).toBeDefined();
    const context = { contract: "v1", operation: "createReport" };
    const sent = JSON.parse(
      runtime.transformRequest(site as never, '{"version":"3.00"}', context),
    );
    expect(sent).toEqual({ version: "4.00" });
    const shown = runtime.transformResponse(
      site as never,
      200,
      '{"version":"4.00"}',
      context,
    );
    expect(JSON.parse(shown)).toEqual({ version: "4.00" });
  });
});
