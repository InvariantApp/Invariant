import type { OpenApiDocument } from "@invariant-app/contract";
import { describe, expect, it } from "vitest";
import { validateAgainst } from "./validate.ts";

/** Qdrant 1.16's optimizer tracker, as its OpenAPI 3.0 document writes it. */
const TRACKER: OpenApiDocument = {
  openapi: "3.0.1",
  info: { title: "qdrant", version: "1.16.0" },
  paths: {},
  components: {
    schemas: {
      TrackerTelemetry: {
        type: "object",
        required: ["name", "start_at"],
        properties: {
          name: { type: "string" },
          start_at: { type: "string", format: "date-time" },
          end_at: { type: "string", format: "date-time", nullable: true },
          state: { type: "string", enum: ["running", "done"], nullable: true },
        },
      },
    },
  },
};

describe("validating a value against a contract", () => {
  it("allows null where an OpenAPI 3.0 schema says nullable, as the generator produces it", () => {
    // The lens laws generated `end_at: null` from this schema and then refused
    // it as not a string, which blocked every Qdrant 1.17 telemetry Change.
    expect(
      validateAgainst(TRACKER, "#/components/schemas/TrackerTelemetry", {
        name: "optimizer",
        start_at: "2020-01-01T00:00:00Z",
        end_at: null,
        state: null,
      }),
    ).toEqual([]);
  });

  it("still refuses null where the schema does not allow it", () => {
    expect(
      validateAgainst(TRACKER, "#/components/schemas/TrackerTelemetry", {
        name: null,
        start_at: "2020-01-01T00:00:00Z",
      }).map((violation) => violation.message),
    ).toEqual(["expected string, found null"]);
  });
});
