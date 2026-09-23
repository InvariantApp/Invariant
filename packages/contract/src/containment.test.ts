/**
 * What `covers` proves and, as much, what it refuses to. A Change that says
 * nothing needs translating is believed on this function's word alone, so a
 * wrong "covered" is the worst answer it can give; a wrong "not covered" only
 * leaves a place unexplained.
 */
import { describe, expect, it } from "vitest";
import { covers } from "./containment.ts";
import type { OpenApiDocument } from "./spec.ts";

const doc = (schemas: Record<string, unknown> = {}) =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {},
    components: { schemas },
  }) as unknown as OpenApiDocument;

/** Whether every value `inner` allows, `outer` allows, each in its own document. */
const holds = (
  outer: unknown,
  inner: unknown,
  outerSchemas: Record<string, unknown> = {},
  innerSchemas: Record<string, unknown> = outerSchemas,
) =>
  covers(
    { document: doc(outerSchemas), schema: outer as never },
    { document: doc(innerSchemas), schema: inner as never },
  );

const string = { type: "string" };

describe("a schema that says less than another", () => {
  it("is covered by itself", () => {
    expect(
      holds(
        { type: "object", properties: { a: string } },
        { type: "object", properties: { a: string } },
      ).covered,
    ).toBe(true);
  });

  it("is covered where it lists fewer of the values, and not where it lists more", () => {
    const wide = { type: "string", enum: ["a", "b", "c"] };
    expect(holds(wide, { type: "string", enum: ["a", "c"] }).covered).toBe(true);
    const more = holds({ type: "string", enum: ["a"] }, wide);
    expect(more).toMatchObject({ covered: false, at: "" });
    if (!more.covered) expect(more.reason).toContain('"b"');
  });

  it("is not covered by a schema that lists values where it lists none", () => {
    expect(holds({ type: "string", enum: ["a"] }, string).covered).toBe(false);
  });

  it("allows an integer where any number was allowed, and not the other way", () => {
    expect(holds({ type: "number" }, { type: "integer" }).covered).toBe(true);
    expect(holds({ type: "integer" }, { type: "number" }).covered).toBe(false);
  });

  it("is not covered once it may be null where it could not", () => {
    expect(holds(string, { type: "string", nullable: true }).covered).toBe(false);
    expect(holds({ type: "string", nullable: true }, string).covered).toBe(true);
    expect(
      holds({ type: ["string", "null"] }, { type: ["string", "null"] }).covered,
    ).toBe(true);
  });

  it("is not covered by a schema that says nothing of its type", () => {
    expect(holds(string, {}).covered).toBe(false);
    expect(holds({}, string).covered).toBe(true);
  });
});

describe("bounds and formats", () => {
  it("keeps a string's length only where the inner states one as tight", () => {
    expect(
      holds({ type: "string", maxLength: 10 }, { type: "string", maxLength: 5 }).covered,
    ).toBe(true);
    expect(
      holds({ type: "string", maxLength: 5 }, { type: "string", maxLength: 10 }).covered,
    ).toBe(false);
    expect(holds({ type: "string", maxLength: 5 }, string).covered).toBe(false);
  });

  it("keeps a format or a pattern only where the inner states the same one", () => {
    expect(holds({ type: "string", format: "date-time" }, string).covered).toBe(false);
    expect(
      holds(
        { type: "string", format: "date-time" },
        { type: "string", format: "date-time" },
      ).covered,
    ).toBe(true);
    expect(
      holds({ type: "string", pattern: "^a" }, { type: "string", pattern: "^b" }).covered,
    ).toBe(false);
  });

  it("checks listed values against the outer bounds one by one", () => {
    expect(
      holds({ type: "string", maxLength: 3 }, { type: "string", enum: ["ab", "abc"] })
        .covered,
    ).toBe(true);
    expect(
      holds({ type: "string", maxLength: 3 }, { type: "string", enum: ["abcd"] }).covered,
    ).toBe(false);
    expect(holds({ type: "string", pattern: "^[a-z]+$" }, { enum: ["ok"] }).covered).toBe(
      true,
    );
    // A format nothing here can check a listed value against is not assumed.
    expect(
      holds({ type: "string", format: "uuid" }, { type: "string", enum: ["x"] }).covered,
    ).toBe(false);
  });

  it("reads a number's bounds either way OpenAPI writes them", () => {
    expect(
      holds({ type: "number", minimum: 0 }, { type: "number", minimum: 1 }).covered,
    ).toBe(true);
    expect(
      holds({ type: "number", minimum: 1 }, { type: "number", minimum: 0 }).covered,
    ).toBe(false);
    // 3.0's boolean exclusive bound against 3.1's numeric one.
    expect(
      holds(
        { type: "number", minimum: 0, exclusiveMinimum: true },
        { type: "number", exclusiveMinimum: 0 },
      ).covered,
    ).toBe(true);
    expect(
      holds({ type: "number", exclusiveMinimum: 0 }, { type: "number", minimum: 0 })
        .covered,
    ).toBe(false);
    expect(
      holds({ type: "number", multipleOf: 2 }, { type: "number", multipleOf: 4 }).covered,
    ).toBe(true);
    expect(
      holds({ type: "number", multipleOf: 4 }, { type: "number", multipleOf: 2 }).covered,
    ).toBe(false);
  });
});

describe("objects and lists", () => {
  it("is not covered where a property the outer always has may be left out", () => {
    const answer = holds(
      { type: "object", required: ["id"], properties: { id: string } },
      { type: "object", properties: { id: string } },
    );
    expect(answer).toMatchObject({ covered: false, at: "/id" });
  });

  it("compares the properties both declare, and takes the rest as never sent", () => {
    const outer = {
      type: "object",
      properties: {
        id: string,
        note: string,
        kind: { type: "string", enum: ["a", "b"] },
      },
    };
    expect(
      holds(outer, { type: "object", properties: { id: string, kind: { enum: ["a"] } } })
        .covered,
    ).toBe(true);
    expect(
      holds(outer, { type: "object", properties: { kind: { type: "string" } } }),
    ).toMatchObject({ covered: false, at: "/kind" });
  });

  it("allows a property the outer does not declare only where the outer allows others", () => {
    const inner = { type: "object", properties: { extra: string } };
    expect(holds({ type: "object" }, inner).covered).toBe(true);
    expect(holds({ type: "object", additionalProperties: false }, inner).covered).toBe(
      false,
    );
    expect(holds({ type: "object", additionalProperties: string }, inner).covered).toBe(
      true,
    );
    expect(
      holds({ type: "object", additionalProperties: { type: "integer" } }, inner).covered,
    ).toBe(false);
  });

  it("compares what a list or a map holds", () => {
    const list = (items: unknown) => ({ type: "array", items });
    expect(holds(list({ type: "number" }), list({ type: "integer" })).covered).toBe(true);
    expect(holds(list({ type: "integer" }), list({ type: "number" }))).toMatchObject({
      covered: false,
      at: "/*",
    });
    const map = (values: unknown) => ({ type: "object", additionalProperties: values });
    expect(holds(map({ type: "number" }), map({ type: "integer" })).covered).toBe(true);
    expect(holds(map({ type: "integer" }), map({ type: "string" }))).toMatchObject({
      covered: false,
      at: "/{}",
    });
  });

  it("finishes on a schema that holds itself, and still finds what differs", () => {
    const node = (child: unknown) => ({
      type: "object",
      required: ["id"],
      properties: { id: string, children: { type: "array", items: child } },
    });
    const same = { Node: node({ $ref: "#/components/schemas/Node" }) };
    expect(
      holds(
        { $ref: "#/components/schemas/Node" },
        { $ref: "#/components/schemas/Node" },
        same,
      ).covered,
    ).toBe(true);
    const looser = {
      Node: {
        type: "object",
        properties: {
          id: string,
          children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
        },
      },
    };
    expect(
      holds(
        { $ref: "#/components/schemas/Node" },
        { $ref: "#/components/schemas/Node" },
        same,
        looser,
      ),
    ).toMatchObject({ covered: false, at: "/id" });
  });
});

describe("choices", () => {
  const effect = {
    type: "object",
    required: ["type", "visible"],
    properties: {
      type: {
        type: "string",
        enum: ["INNER_SHADOW", "DROP_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"],
      },
      visible: { type: "boolean" },
      radius: { type: "number", minimum: 0 },
      color: { $ref: "#/components/schemas/RGBA" },
      spread: { type: "number" },
    },
  };
  const rgba = { type: "object", required: ["r"], properties: { r: { type: "number" } } };
  const kind = (types: string[], extra: Record<string, unknown> = {}) => ({
    allOf: [
      {
        type: "object",
        required: ["type", "visible"],
        properties: {
          type: { type: "string", enum: types },
          visible: { type: "boolean" },
        },
      },
      { type: "object", properties: extra },
    ],
  });
  const split = {
    RGBA: rgba,
    DropShadowEffect: kind(["DROP_SHADOW"], {
      radius: { type: "number", minimum: 0 },
      color: { $ref: "#/components/schemas/RGBA" },
      spread: { type: "number" },
    }),
    InnerShadowEffect: kind(["INNER_SHADOW"], {
      color: { $ref: "#/components/schemas/RGBA" },
    }),
    BlurEffect: kind(["LAYER_BLUR", "BACKGROUND_BLUR"], {
      radius: { type: "number", minimum: 0 },
    }),
    Effect: {
      oneOf: [
        { $ref: "#/components/schemas/DropShadowEffect" },
        { $ref: "#/components/schemas/InnerShadowEffect" },
        { $ref: "#/components/schemas/BlurEffect" },
      ],
      discriminator: { propertyName: "type" },
    },
  };

  it("covers one object split into kinds that each say less (Figma)", () => {
    expect(
      holds(
        { $ref: "#/components/schemas/Effect" },
        { $ref: "#/components/schemas/Effect" },
        { RGBA: rgba, Effect: effect },
        split,
      ).covered,
    ).toBe(true);
  });

  it("does not cover a split where one kind is something the old one never was", () => {
    const answer = holds(
      { $ref: "#/components/schemas/Effect" },
      { $ref: "#/components/schemas/Effect" },
      { RGBA: rgba, Effect: effect },
      {
        ...split,
        BlurEffect: kind(["LAYER_BLUR", "MOTION_BLUR"]),
      },
    );
    expect(answer.covered).toBe(false);
    if (!answer.covered) {
      expect(answer.reason).toContain("choice 3 of 3");
      expect(answer.reason).toContain("MOTION_BLUR");
    }
  });

  it("reads a discriminator's property as required in every branch, as OpenAPI does", () => {
    // Figma's inner shadow does not list `type` as required; its union's
    // discriminator reads `type`, which OpenAPI says every value carries.
    const outer = {
      type: "object",
      required: ["type"],
      properties: { type: { type: "string", enum: ["INNER", "DROP"] } },
    };
    const branch = (value: string) => ({
      type: "object",
      properties: { type: { type: "string", enum: [value] } },
    });
    const union = { oneOf: [branch("INNER"), branch("DROP")] };
    expect(
      holds(outer, { ...union, discriminator: { propertyName: "type" } }).covered,
    ).toBe(true);
    // Without one, a branch that may leave `type` out is not what was promised.
    expect(holds(outer, union)).toMatchObject({ covered: false, at: "/type" });
  });

  it("covers a value by the one branch of an outer oneOf that can hold it", () => {
    const shape = (kind: string) => ({
      type: "object",
      required: ["kind"],
      properties: { kind: { type: "string", enum: [kind] }, size: { type: "number" } },
    });
    const outer = { oneOf: [shape("a"), shape("b")] };
    expect(holds(outer, shape("a")).covered).toBe(true);
    // Nothing tells the branches apart, so the value could match both.
    const ambiguous = {
      oneOf: [
        { type: "object", properties: { size: { type: "number" } } },
        { type: "object", properties: { name: string } },
      ],
    };
    const answer = holds(ambiguous, {
      type: "object",
      properties: { size: { type: "integer" } },
    });
    expect(answer.covered).toBe(false);
    if (!answer.covered) expect(answer.reason).toContain("could match it twice");
    // anyOf asks only that some branch allows it.
    expect(
      holds(
        { anyOf: ambiguous.oneOf },
        { type: "object", properties: { size: { type: "integer" } } },
      ).covered,
    ).toBe(true);
  });

  it("covers an object whose kinds each have a branch of their own", () => {
    const shape = (kinds: string[], extra = {}) => ({
      type: "object",
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: kinds },
        size: { type: "number" },
        ...extra,
      },
    });
    // What was sent as `a` or `b` is now a branch for each, and one more.
    const outer = { oneOf: [shape(["a"]), shape(["b"]), shape(["c"])] };
    expect(holds(outer, shape(["a", "b"])).covered).toBe(true);
    // Not where one of its kinds has no branch.
    expect(holds({ oneOf: [shape(["a"])] }, shape(["a", "b"])).covered).toBe(false);
    // Nor where the branch for a kind says more about it than it did.
    const strict = {
      oneOf: [shape(["a"]), { ...shape(["b"]), required: ["kind", "size"] }],
    };
    expect(holds(strict, shape(["a", "b"])).covered).toBe(false);
    // Only on a property it always has: one it may leave out is a value
    // no branch was shown to allow.
    expect(holds(outer, { ...shape(["a", "b"]), required: [] }).covered).toBe(false);
  });

  it("does not compare what it does not understand", () => {
    const answer = holds({ type: "string", not: { enum: ["x"] } }, string);
    expect(answer.covered).toBe(false);
    if (!answer.covered) expect(answer.reason).toContain("`not`");
    // The same statement on both sides says the same thing.
    expect(
      holds(
        { type: "string", not: { enum: ["x"] } },
        { type: "string", not: { enum: ["x"] } },
      ).covered,
    ).toBe(true);
  });
});
