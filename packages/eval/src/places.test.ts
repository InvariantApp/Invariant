/**
 * A delta counted once per place, so a shared schema's one change is one
 * change however many operations return it.
 */
import type { DiffEntry } from "@invariant-app/diff";
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

  it("is the same for one schema's field however many routes through a union reach it", () => {
    // Figma's node tree: one enum value added to ConnectorNode, reported once
    // for every chain of children and unions that can hold one.
    const reached = (route: string) =>
      entry(
        "response-property-enum-value-added",
        `added the new \`CURVED\` enum value to the \`${route}oneOf[#/components/schemas/ConnectorNode]/connectorLineType\` response property for the response status \`200\``,
        "GET",
        "/v1/files/{file_key}",
      );
    const places = new Set(
      [
        "document/children/items/children/items/",
        "nodes/additionalProperties/document/oneOf[#/components/schemas/CanvasNode]/children/items/",
        "document/children/items/oneOf[#/components/schemas/FrameNode]/children/items/",
      ].map((route) => placeOf(reached(route))),
    );
    expect(places.size).toBe(1);
    expect([...places][0]).toContain(
      "`#/components/schemas/ConnectorNode/connectorLineType`",
    );
  });

  it("still tells apart two fields of the same schema", () => {
    const at = (field: string) =>
      entry(
        "response-property-enum-value-added",
        `added the new \`X\` enum value to the \`a/oneOf[#/components/schemas/Node]/${field}\` response property for the response status \`200\``,
        "GET",
        "/v1/files",
      );
    expect(placeOf(at("kind"))).not.toBe(placeOf(at("state")));
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
