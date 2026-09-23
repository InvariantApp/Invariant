/**
 * Values generated from real schemas.
 *
 * Every case here is a shape a real specification contained that the
 * generator once got wrong. A generator that cannot produce a valid value
 * leaves a law or a traffic sample proving nothing, and one that never
 * returns stops the run it is part of.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { valueArbitrary } from "./arbitrary.ts";

const document = { openapi: "3.0.3", info: { title: "t", version: "1" }, paths: {} };
const sample = (schema: object, runs = 50) =>
  fc.sample(valueArbitrary(document as never, schema as never), {
    numRuns: runs,
    seed: 3,
  });

describe("strings with a pattern", () => {
  // Twilio Memory's conversation ids are 44 characters and declare no
  // maxLength. A default length cap filtered out every candidate, and
  // fast-check retried forever.
  it("are not held to a length the schema never declared", () => {
    const pattern = "^conv_conversation_[0-7][0-9a-z]{25}$";
    const values = sample({ type: "string", pattern });
    expect(values.every((value) => new RegExp(pattern).test(value as string))).toBe(true);
  });

  it("are held to the lengths the schema does declare", () => {
    const values = sample({
      type: "string",
      pattern: "^[a-z]+$",
      minLength: 3,
      maxLength: 5,
    });
    expect(
      values.every(
        (value) => (value as string).length >= 3 && (value as string).length <= 5,
      ),
    ).toBe(true);
  });

  it("still finish when the declared lengths contradict the pattern", () => {
    // No string satisfies both; the generator returns pattern matches and
    // leaves the contradiction for the oracle to count.
    const values = sample({ type: "string", pattern: "^[a-z]{30}$", maxLength: 10 }, 5);
    expect(values).toHaveLength(5);
  });
});

describe("deeply nested objects", () => {
  // Adyen's terminal API nests required fields well past the generator's
  // depth limit. Cutting an object to `{}` there dropped them, and the value
  // failed its own contract.
  it("still carry their required fields past the depth limit", () => {
    let schema: object = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, note: { type: "string" } },
    };
    for (let level = 0; level < 10; level += 1) {
      schema = {
        type: "object",
        required: ["inner", "list"],
        properties: {
          inner: schema,
          list: { type: "array", minItems: 1, items: { type: "integer" } },
        },
      };
    }
    for (const value of sample(schema, 20)) {
      let node = value as Record<string, unknown>;
      for (let level = 0; level < 10; level += 1) {
        expect((node["list"] as unknown[]).length).toBeGreaterThanOrEqual(1);
        node = node["inner"] as Record<string, unknown>;
      }
      expect(typeof node["id"]).toBe("string");
    }
  });

  it("stop at a required cycle instead of recursing forever", () => {
    const cyclic = {
      ...document,
      components: {
        schemas: {
          Node: {
            type: "object",
            required: ["next"],
            properties: { next: { $ref: "#/components/schemas/Node" } },
          },
        },
      },
    };
    const values = fc.sample(
      valueArbitrary(cyclic as never, { $ref: "#/components/schemas/Node" } as never),
      { numRuns: 3, seed: 1 },
    );
    expect(values).toHaveLength(3);
  });
});

describe("integers bounded past what a double holds exactly", () => {
  // NetBox, through drf-spectacular, bounds every 64-bit column by
  // 9223372036854775807, which is not a safe integer. Handed that bound,
  // fast-check's integer drew forever, and the gate's laws on NetBox 3.6
  // outlasted a two and a half hour job without finishing a single schema.
  it("finish, inside the declared range", () => {
    // Read from JSON text, as a served document is.
    for (const bounds of [
      '{"minimum": 0, "maximum": 9223372036854775807}',
      '{"minimum": -9223372036854775808, "maximum": 9223372036854775807}',
      '{"minimum": 1, "maximum": 18446744073709551615}',
    ]) {
      const schema = { type: "integer", ...JSON.parse(bounds) };
      const values = sample(schema, 20);
      expect(values).toHaveLength(20);
      for (const value of values) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value as number).toBeGreaterThanOrEqual(schema.minimum);
      }
    }
  });
});

describe("enums listing a value their type rules out", () => {
  // drf-spectacular lists null among a choice field's values whatever else
  // the schema says: NetBox's `poe_mode.value` is `type: string` with
  // `enum: [pd, pse, "", null]` and no `nullable`. A null drawn from that list
  // is refused by the schema it came from, and the laws blamed the Changes on
  // Interface for it.
  it("draw only the values the rest of the schema allows", () => {
    const values = sample({ type: "string", enum: ["pd", "pse", "", null] }, 200);
    expect(values).not.toContain(null);
    expect(new Set(values)).toEqual(new Set(["pd", "pse", ""]));
  });

  it("still draw null where the schema is nullable", () => {
    const values = sample(
      { type: "string", enum: ["pd", "pse", "", null], nullable: true },
      200,
    );
    expect(values).toContain(null);
  });
});

describe("formats", () => {
  it("generates base64 for byte", () => {
    for (const value of sample({ type: "string", format: "byte" })) {
      expect(value).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    }
  });
});

describe("allOf", () => {
  // How AWS's specifications, converted from Smithy, describe nearly every
  // field. Merging only the object branches turned each into `{}`.
  it("merges branches that are not objects", () => {
    const aws = {
      ...document,
      components: {
        schemas: { ResourceName: { type: "string", minLength: 1, maxLength: 255 } },
      },
    };
    const values = fc.sample(
      valueArbitrary(
        aws as never,
        {
          allOf: [
            { $ref: "#/components/schemas/ResourceName" },
            { description: "The name." },
          ],
        } as never,
      ),
      { numRuns: 30, seed: 2 },
    );
    for (const value of values) {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("still merges object branches", () => {
    const [value] = sample({
      allOf: [
        { type: "object", required: ["a"], properties: { a: { type: "integer" } } },
        { type: "object", required: ["b"], properties: { b: { type: "boolean" } } },
      ],
    });
    expect(value).toEqual({ a: expect.any(Number), b: expect.any(Boolean) });
  });
});

describe("unions beside other keywords", () => {
  it("keeps the parent's properties in whichever branch is taken", () => {
    // GitHub's request-reviewers body.
    const values = sample({
      type: "object",
      properties: {
        reviewers: { type: "array", items: { type: "string" } },
        team_reviewers: { type: "array", items: { type: "string" } },
      },
      anyOf: [{ required: ["reviewers"] }, { required: ["team_reviewers"] }],
    });
    for (const value of values) {
      const body = value as Record<string, unknown>;
      expect(
        Array.isArray(body["reviewers"]) || Array.isArray(body["team_reviewers"]),
      ).toBe(true);
    }
  });
});

describe("long patterned strings", () => {
  it("reach a minimum length the default size does not", () => {
    for (const value of sample({
      type: "string",
      pattern: "^[0-9a-f]+$",
      minLength: 40,
      maxLength: 40,
    })) {
      expect(value).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("patterns with their own bounds", () => {
  it("keep them when lengths are also declared", () => {
    for (const value of sample({ type: "string", pattern: "^.{2,2}$", maxLength: 10 })) {
      expect((value as string).length).toBe(2);
    }
  });
});

describe("required names", () => {
  it("are present even when the schema never describes them", () => {
    // GitHub's docker package metadata requires `tags` and declares `tag`.
    for (const value of sample({
      type: "object",
      properties: { tag: { type: "array", items: { type: "string" } } },
      required: ["tags"],
    })) {
      expect(value).toHaveProperty("tags");
    }
  });
});

describe("more formats", () => {
  it("generates what a JSON Schema validator means by each", () => {
    for (const value of sample({ type: "string", format: "duration" })) {
      expect(value).toMatch(/^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/);
    }
    for (const value of sample({ type: "string", format: "time" })) {
      expect(value).toMatch(/^\d{2}:\d{2}:\d{2}Z$/);
    }
  });
});

describe("oneOf", () => {
  it("generates values exactly one branch accepts", () => {
    // GitHub's add-labels body, where `{}` satisfies both object forms.
    const labels = {
      oneOf: [
        {
          type: "object",
          properties: {
            labels: { type: "array", minItems: 1, items: { type: "string" } },
          },
        },
        { type: "array", minItems: 1, items: { type: "string" } },
        {
          type: "object",
          properties: {
            labels: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        { type: "string" },
      ],
    };
    for (const value of sample(labels, 100)) {
      expect(value).not.toEqual({});
    }
  });
});
