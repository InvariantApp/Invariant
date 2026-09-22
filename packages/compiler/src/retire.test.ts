/**
 * When a retirement is refused outright, and when the call is passed on.
 *
 * Passed on by default, since a specification can drop an operation its
 * server still serves. Refused when the Change says the server no longer
 * serves it, and whenever passing the call on could reach a different
 * operation of the new contract, which no answer from the provider could put
 * right.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { parseChange } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { projectStep } from "./project.ts";

const contract = (paths: Record<string, string[]>): OpenApiDocument =>
  ({
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: Object.fromEntries(
      Object.entries(paths).map(([path, methods]) => [
        path,
        Object.fromEntries(
          methods.map((method) => [
            method,
            { responses: { "200": { description: "ok" } } },
          ]),
        ),
      ]),
    ),
  }) as unknown as OpenApiDocument;

const retire = (path: string, refuse?: boolean) =>
  parseChange({
    irVersion: 1,
    id: "chg_retired",
    summary: "gone",
    ops: [
      {
        op: "retire",
        endpoint: { method: "post", path },
        ...(refuse === undefined ? {} : { refuse }),
      },
    ],
  });

const refused = (path: string, next: Record<string, string[]>, refuse?: boolean) =>
  projectStep(
    "old",
    contract({ [path]: ["post"] }),
    [retire(path, refuse)],
    contract(next),
  ).program.retired[0]?.refuse;

describe("a retired operation", () => {
  it("is passed on when nothing in the new contract could take its calls", () => {
    expect(
      refused("/collections/{name}/points/search", {
        "/collections/{name}/points/query": ["post"],
      }),
    ).toBeUndefined();
  });

  it("is refused when the Change says the server no longer serves it", () => {
    expect(refused("/v1/refunds", {}, true)).toBe(true);
  });

  it("is refused when another operation's template could match its calls", () => {
    // POST /v1/charges/capture would reach POST /v1/charges/{id} if passed on.
    expect(refused("/v1/charges/capture", { "/v1/charges/{id}": ["post"] })).toBe(true);
    expect(
      refused("/v1/charges/{id}/capture", { "/v1/charges/refunds/capture": ["post"] }),
    ).toBe(true);
  });

  it("is not refused because of an operation with another method or length", () => {
    expect(
      refused("/v1/charges/capture", {
        "/v1/charges/{id}": ["get"],
        "/v1/charges/{id}/items": ["post"],
      }),
    ).toBeUndefined();
  });
});
