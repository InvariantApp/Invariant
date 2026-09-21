/**
 * A delta counted once per place, so a shared schema's one change is one
 * change however many operations return it.
 */
import type { DiffEntry } from "@invariant/diff";
import { describe, expect, it } from "vitest";
import { placeOf } from "./real.ts";

function entry(id: string, text: string, operation: string, path: string): DiffEntry {
  return {
    id,
    text,
    level: 3,
    operation,
    operationId: `${operation} ${path}`,
    path,
    section: "paths",
    fingerprint: `${id}${operation}${path}`,
  };
}

describe("a delta's place", () => {
  it("is the same for one property returned by many operations and statuses", () => {
    const added = (operation: string, path: string, status: string) =>
      entry(
        "response-property-enum-value-added",
        `added the new \`review\` enum value to the \`status\` response property for the response status \`${status}\``,
        operation,
        path,
      );
    expect(placeOf(added("GET", "/v1/charges/{id}", "200"))).toBe(
      placeOf(added("POST", "/v1/charges", "201")),
    );
  });

  it("differs where the property sits somewhere else in the body", () => {
    const at = (property: string) =>
      entry(
        "response-property-enum-value-added",
        `added the new \`review\` enum value to the \`${property}\` response property for the response status \`200\``,
        "GET",
        "/v1/charges",
      );
    expect(placeOf(at("status"))).not.toBe(placeOf(at("data/items/status")));
  });

  it("keeps the operation for a delta that names no property", () => {
    const removed = (path: string) =>
      entry(
        "api-path-removed-without-deprecation",
        "api path removed without deprecation",
        "GET",
        path,
      );
    expect(placeOf(removed("/v1/a"))).not.toBe(placeOf(removed("/v1/b")));
  });
});
