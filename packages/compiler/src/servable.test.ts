/**
 * L1: the gate never passes a release whose declared Changes cannot all be
 * served.
 *
 * The gate passes a release when the chained program compiles without
 * projection issues. So the property is: for any Change at all, either the
 * program carries work for every one of its ops, or compiling it reports an
 * issue, which the gate turns into a block. A Change that compiles cleanly to
 * nothing is the hole this closes.
 *
 * The Changes are generated from the IR's own JSON Schema, walking its unions,
 * so an op kind or codec added later is covered without anyone remembering
 * to add it here. Only the leaves come from a real contract: its schema names,
 * pointers into them, and its endpoints, plus a few that do not exist, so the
 * generated Changes land on real sites as well as on nothing.
 */
import { readFileSync } from "node:fs";
import { findSchemaSites, type OpenApiDocument } from "@invariant-app/contract";
import {
  type Change,
  type ConvertOp,
  irJsonSchemas,
  isDataOp,
  parseChange,
  type ScalarType,
} from "@invariant-app/ir";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { predictDocument } from "./predict.ts";

/**
 * A contract with every kind of field a data op can meet, each used in a
 * request body, a response body and a list, so every op kind has somewhere
 * real to land.
 */
/** An expandable field, as Stripe writes them: the id, or the object. */
const CUSTOMER_UNION = {
  anyOf: [{ type: "string" }, { $ref: "#/components/schemas/Customer" }],
};

const OLD = {
  openapi: "3.0.3",
  info: { title: "shop", version: "1" },
  paths: {
    "/v1/orders": {
      post: {
        operationId: "createOrder",
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/OrderCreate" } },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Order" } },
            },
          },
        },
      },
      get: {
        operationId: "listOrders",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
          {
            name: "sort",
            in: "query",
            schema: { type: "string", enum: ["asc", "desc"] },
          },
          { name: "Idempotency-Key", in: "header", schema: { type: "string" } },
          { name: "X-Page-Size", in: "header", schema: { type: "integer" } },
          {
            name: "X-Sort",
            in: "header",
            schema: { type: "string", enum: ["asc", "desc"] },
          },
          { name: "Authorization", in: "header", schema: { type: "string" } },
          {
            name: "ids",
            in: "query",
            schema: { type: "array", items: { type: "string" } },
          },
          {
            name: "X-Ids",
            in: "header",
            schema: { type: "array", items: { type: "string" } },
          },
          {
            name: "ids",
            in: "cookie",
            schema: { type: "array", items: { type: "string" } },
          },
          ...(["query", "header", "cookie"] as const).map((location) => ({
            name: location === "header" ? "X-Fields" : "fields",
            in: location,
            schema: {
              type: "array",
              items: { type: "string", enum: ["name", "color", "owner"] },
            },
          })),
          { name: "page", in: "cookie", schema: { type: "integer" } },
          {
            name: "order",
            in: "cookie",
            schema: { type: "string", enum: ["asc", "desc"] },
          },
        ],
        responses: {
          "200": {
            description: "a page",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/OrderList" } },
            },
          },
        },
      },
    },
    "/v1/orders/{id}": {
      get: {
        operationId: "getOrder",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "an order",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Order" } },
            },
          },
        },
      },
    },
    "/v1/refunds": {
      post: {
        operationId: "createRefund",
        responses: { "204": { description: "done" } },
      },
    },
    // A response body written in place, reached by a response scope.
    "/v1/orders/{id}/summary": {
      get: {
        operationId: "getOrderSummary",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "a summary",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    state: { type: "string", enum: ["open", "closed"] },
                    total: { type: "integer" },
                    note: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    // A schema that contains itself, served by blocks that follow the value.
    "/v1/threads": {
      post: {
        operationId: "createThread",
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Thread" } },
          },
        },
        responses: {
          "200": {
            description: "a thread",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Thread" } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      OrderCreate: {
        type: "object",
        required: ["amount", "status"],
        properties: {
          amount: { type: "number", multipleOf: 0.01 },
          count: { type: "integer" },
          status: { type: "string", enum: ["pending", "paid", "void"] },
          note: { type: "string" },
          gift: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          flags: {
            type: "array",
            items: { type: "string", enum: ["gift", "rush", "fragile"] },
          },
          shipping: {
            type: "object",
            properties: { city: { type: "string" }, zip: { type: "string" } },
          },
          customer: CUSTOMER_UNION,
        },
      },
      Order: {
        type: "object",
        required: ["id", "amount", "status"],
        properties: {
          id: { type: "string" },
          amount: { type: "number", multipleOf: 0.01 },
          count: { type: "integer" },
          status: { type: "string", enum: ["pending", "paid", "void"] },
          note: { type: "string" },
          gift: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          flags: {
            type: "array",
            items: { type: "string", enum: ["gift", "rush", "fragile"] },
          },
          shipping: {
            type: "object",
            properties: { city: { type: "string" }, zip: { type: "string" } },
          },
          customer: CUSTOMER_UNION,
        },
      },
      Customer: {
        type: "object",
        required: ["object"],
        properties: {
          object: { type: "string", enum: ["customer"] },
          id: { type: "string" },
          name: { type: "string" },
        },
      },
      OrderList: {
        type: "object",
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/Order" } },
          has_more: { type: "boolean" },
        },
      },
      Unused: { type: "object", properties: { x: { type: "string" } } },
      Thread: {
        type: "object",
        properties: {
          title: { type: "string" },
          count: { type: "integer" },
          status: { type: "string", enum: ["pending", "paid", "void"] },
          replies: { type: "array", items: { $ref: "#/components/schemas/Thread" } },
        },
      },
    },
  },
} as unknown as OpenApiDocument;

type Schema = Record<string, unknown>;

// What the provider sends of its own accord: an event carrying a schema shaped
// as Order is, which reaches subscribers and nobody else.
{
  const schemas = (OLD["components"] as { schemas: Record<string, Schema> }).schemas;
  schemas["OrderEvent"] = structuredClone(schemas["Order"] as Schema);
  (OLD as Record<string, unknown>)["webhooks"] = {
    "order.paid": {
      post: {
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/OrderEvent" } },
          },
        },
        responses: { "200": { description: "received" } },
      },
    },
  };
}

/**
 * The new contract: the old one with a field and parameters only it has,
 * since `add` and a rename take what arrives from the contract it arrives in.
 */
const NEW = structuredClone(OLD) as OpenApiDocument;
{
  // A kind of customer old callers never heard of.
  const schemas = (NEW["components"] as { schemas: Record<string, Schema> }).schemas;
  schemas["Guest"] = {
    type: "object",
    required: ["object"],
    properties: {
      object: { type: "string", enum: ["guest"] },
      id: { type: "string" },
    },
  };
  for (const name of ["Order", "OrderCreate", "OrderEvent"]) {
    const customer = (
      (schemas[name] as Schema)["properties"] as Record<string, { anyOf: unknown[] }>
    )["customer"] as { anyOf: unknown[] };
    customer.anyOf.push({ $ref: "#/components/schemas/Guest" });
  }
}
for (const name of ["Order", "OrderCreate", "OrderEvent"]) {
  const schema = (NEW["components"] as { schemas: Record<string, Schema> }).schemas[
    name
  ] as Schema;
  (schema["properties"] as Record<string, unknown>)["added_field"] = { type: "string" };
}
{
  const summary = JSON.parse(
    JSON.stringify(
      (NEW["paths"] as Record<string, Record<string, Schema>>)["/v1/orders/{id}/summary"],
    ),
  ) as {
    get: { responses: Record<string, { content: Record<string, { schema: Schema }> }> };
  };
  const body = summary.get.responses["200"]?.content["application/json"]
    ?.schema as Schema;
  (body["properties"] as Record<string, unknown>)["added_field"] = { type: "string" };
  (NEW["paths"] as Record<string, unknown>)["/v1/orders/{id}/summary"] = summary;
}
(
  ((NEW["paths"] as Record<string, Schema>)["/v1/orders"] as Record<string, Schema>)[
    "get"
  ] as { parameters: unknown[] }
).parameters.push(
  { name: "page_size", in: "query", schema: { type: "integer" } },
  { name: "cursor", in: "query", schema: { type: "string" } },
  { name: "X-Limit", in: "header", schema: { type: "integer" } },
  { name: "X-Cursor", in: "header", schema: { type: "string" } },
  { name: "page_number", in: "cookie", schema: { type: "integer" } },
  { name: "session_hint", in: "cookie", schema: { type: "string" } },
);

const schemas = (OLD["components"] as { schemas: Record<string, Schema> }).schemas;
const SCHEMA_REFS = [
  ...Object.keys(schemas).map((name) => `#/components/schemas/${name}`),
  "#/components/schemas/NotInTheContract",
  // Only in the new contract: what a union can newly hold.
  "#/components/schemas/Guest",
];

/** Every pointer into the contract's schemas, a level or two deep. */
function pointersOf(
  schema: unknown,
  prefix: string,
  depth: number,
  out: Set<string>,
): void {
  if (depth > 2 || !schema || typeof schema !== "object") return;
  const node = schema as Schema;
  if (typeof node["$ref"] === "string") {
    const name = (node["$ref"] as string).split("/").pop() as string;
    pointersOf(schemas[name], prefix, depth, out);
    return;
  }
  for (const [name, child] of Object.entries(
    (node["properties"] as Record<string, unknown>) ?? {},
  )) {
    out.add(`${prefix}/${name}`);
    pointersOf(child, `${prefix}/${name}`, depth + 1, out);
  }
  if (node["items"]) pointersOf(node["items"], `${prefix}/*`, depth + 1, out);
}
const POINTER_SET = new Set<string>(["/not_there", "/nested/not_there"]);
for (const schema of Object.values(schemas)) pointersOf(schema, "", 0, POINTER_SET);
const POINTERS = [...POINTER_SET];

const PATHS = [...Object.keys(OLD["paths"] as object), "/v9/never"];
const OPERATIONS = Object.entries(OLD["paths"] as Record<string, Record<string, Schema>>)
  .flatMap(([, item]) => Object.values(item).map((op) => op["operationId"]))
  .filter((id): id is string => typeof id === "string");

/** A generator for any value a JSON Schema allows, with leaves from the contract. */
function arbitraryOf(schema: Schema, name = ""): fc.Arbitrary<unknown> {
  const union = (schema["anyOf"] ?? schema["oneOf"]) as Schema[] | undefined;
  if (union) return fc.oneof(...union.map((branch) => arbitraryOf(branch, name)));
  if (schema["const"] !== undefined) return fc.constant(schema["const"]);
  if (Array.isArray(schema["enum"]))
    return fc.constantFrom(...(schema["enum"] as unknown[]));

  switch (schema["type"]) {
    case "object": {
      const properties = (schema["properties"] ?? {}) as Record<string, Schema>;
      const required = new Set((schema["required"] ?? []) as string[]);
      const record: Record<string, fc.Arbitrary<unknown>> = {};
      for (const [key, child] of Object.entries(properties)) {
        const value = arbitraryOf(child, key);
        record[key] = required.has(key) ? value : fc.option(value, { nil: undefined });
      }
      return fc
        .record(record)
        .map((value) =>
          Object.fromEntries(
            Object.entries(value).filter(([, entry]) => entry !== undefined),
          ),
        );
    }
    case "array": {
      // A tuple, as TypeBox writes one: positional item schemas.
      const positional = (schema["prefixItems"] ?? schema["items"]) as Schema | Schema[];
      if (Array.isArray(positional)) {
        return fc.tuple(...positional.map((item) => arbitraryOf(item, name)));
      }
      return fc.array(arbitraryOf(positional, name), {
        minLength: (schema["minItems"] as number | undefined) ?? 0,
        maxLength: 3,
      });
    }
    case "integer":
      return fc.integer({
        min: (schema["minimum"] as number | undefined) ?? -12,
        max: (schema["maximum"] as number | undefined) ?? 12,
      });
    case "number":
      return fc.double({ min: 0, max: 1, noNaN: true });
    case "boolean":
      return fc.boolean();
    case "string": {
      const pattern = schema["pattern"] as string | undefined;
      if (pattern === "^#/components/schemas/") return fc.constantFrom(...SCHEMA_REFS);
      if (pattern?.startsWith("^(/(")) return fc.constantFrom(...POINTERS);
      if (pattern === "^/") return fc.constantFrom(...PATHS);
      if (pattern === "^[a-z][a-z0-9_]*$")
        return fc.constantFrom("chg_generated", "chg_other");
      if (name === "operation") return fc.constantFrom(...OPERATIONS, "noSuchOperation");
      return fc.constantFrom(
        "paid",
        "pending",
        "amount",
        "flag_name",
        "Use the new one.",
      );
    }
    default:
      // Unconstrained values: what `add` supplies and `remove` restores.
      return fc.oneof(
        fc.constant(0),
        fc.constant("x"),
        fc.constant(null),
        fc.constant({}),
      );
  }
}

const CHANGE = arbitraryOf(
  (irJsonSchemas()["$defs"] as Record<string, Schema>)["Change"] as Schema,
).chain((value) => {
  try {
    return fc.constant(parseChange(value));
  } catch {
    // A value the schema's shape allows but its validator refuses, such as an
    // enum map with a value on both sides: not a Change anyone can release.
    return fc.constant(undefined);
  }
});

interface Field {
  pointer: string;
  type: string;
  enum?: string[];
  required: boolean;
}

/** The scalar fields of each schema, by pointer, as a data op would name them. */
function fieldsOf(schema: Schema, prefix = "", required = true): Field[] {
  const needed = new Set((schema["required"] ?? []) as string[]);
  return Object.entries((schema["properties"] ?? {}) as Record<string, Schema>).flatMap(
    ([name, child]) =>
      child["type"] === "object"
        ? fieldsOf(child, `${prefix}/${name}`, false)
        : typeof child["type"] === "string"
          ? [
              {
                pointer: `${prefix}/${name}`,
                type: child["type"] as string,
                ...(Array.isArray(child["enum"])
                  ? { enum: child["enum"] as string[] }
                  : {}),
                required: required && needed.has(name),
              },
            ]
          : [],
  );
}

/**
 * For each location: a number, an enum, a list, a name only the new contract
 * has, and one it adds.
 */
const NAMES: Record<
  string,
  {
    num: string;
    enum: string;
    list: string;
    renamed: string;
    added: string;
    /** A list whose items list their values. */
    fields: string;
  }
> = {
  query: {
    num: "limit",
    enum: "sort",
    list: "ids",
    renamed: "page_size",
    added: "cursor",
    fields: "fields",
  },
  header: {
    num: "X-Page-Size",
    enum: "X-Sort",
    list: "X-Ids",
    renamed: "X-Limit",
    added: "X-Cursor",
    fields: "X-Fields",
  },
  cookie: {
    num: "page",
    enum: "order",
    list: "ids",
    renamed: "page_number",
    added: "session_hint",
    fields: "fields",
  },
  path: {
    num: "id",
    enum: "id",
    list: "id",
    renamed: "order_id",
    added: "extra",
    fields: "id",
  },
};

/**
 * The same Change with its data ops pointed at fields of its own scope that
 * suit them: a scale at a number, an enum map over the field's real values, a
 * cast from the field's own type. Without this, random leaves almost never
 * line up, and the converts never reach the path where they would be served.
 */
function fit(change: Change | undefined): fc.Arbitrary<Change | undefined> {
  if (!change?.ops.some(isDataOp)) return fc.constant(change);
  // One schema the contract uses, or one operation's parameters, in place of
  // whatever scopes were drawn: a stray scope would block the Change before
  // it could be served.
  return fc.oneof(
    fc.constantFrom("Order", "OrderCreate").chain((name) => fitTo(change, name)),
    fc
      .constantFrom("query", "header", "cookie")
      .map((location) => fitToParameters(change, location)),
    fc.constant(fitToResponse(change)),
  );
}

/** The Change's data ops aimed at the fields of a response body written in place. */
function fitToResponse(change: Change): Change | undefined {
  const ops = change.ops.map((op) => {
    switch (op.op) {
      case "move":
        return { op: "move", from: "/note", to: "/memo" };
      case "convert":
        switch (op.codec.kind) {
          case "enumMap":
            return {
              op: "convert",
              path: "/state",
              codec: {
                kind: "enumMap",
                pairs: [
                  ["open", "opened"],
                  ["closed", "shut"],
                ],
              },
            };
          case "stringCase":
            return {
              op: "convert",
              path: "/state",
              codec: { kind: "stringCase", from: "snake", to: "screaming" },
            };
          case "dateFormat":
            return {
              op: "convert",
              path: "/total",
              codec: { kind: "dateFormat", from: "epoch-s", to: "rfc3339" },
            };
          case "wrapArray":
            return { op: "convert", path: "/note", codec: { kind: "wrapArray" } };
          case "unwrapSingle":
            return op;
          default:
            return {
              op: "convert",
              path: "/total",
              codec: { kind: "cast", from: "integer", to: "string" },
            };
        }
      case "add":
        return { ...op, path: "/added_field" };
      case "remove":
        return { ...op, path: "/note" };
      case "default":
      case "dropNull":
        // A response faces old callers only.
        return { ...op, path: "/note", toward: "old" };
      case "relax":
        return { op: "relax", path: "/total", set: { maximum: null } };
      default:
        return op;
    }
  });
  try {
    return parseChange({
      ...change,
      scopes: [{ operation: "getOrderSummary", response: "200" }],
      ops,
    });
  } catch {
    return undefined;
  }
}

/** The Change's data ops aimed at real parameters of one location. */
function fitToParameters(change: Change, location: string): Change | undefined {
  const n = NAMES[location] as (typeof NAMES)[string];
  const ops = change.ops.map((op) => {
    switch (op.op) {
      case "move":
        return { op: "move", from: `/${n.num}`, to: `/${n.renamed}` };
      case "convert":
        if (op.codec.kind === "enumMap") {
          return {
            ...op,
            path: `/${n.enum}`,
            codec: {
              kind: "enumMap",
              pairs: [
                ["asc", "ascending"],
                ["desc", "descending"],
              ],
            },
          };
        }
        if (op.codec.kind === "cast") {
          return {
            ...op,
            path: `/${n.num}`,
            codec: { kind: "cast", from: "integer", to: "string" },
          };
        }
        if (op.codec.kind === "dateFormat") {
          return {
            ...op,
            path: `/${n.num}`,
            codec: { kind: "dateFormat", from: "epoch-s", to: "rfc3339" },
          };
        }
        if (op.codec.kind === "stringCase") {
          return {
            ...op,
            path: `/${n.enum}`,
            codec: { kind: "stringCase", from: "snake", to: "screaming" },
          };
        }
        if (op.codec.kind === "unwrapSingle") return { ...op, path: `/${n.list}` };
        if (op.codec.kind === "dropValues") {
          return {
            ...op,
            path: `/${n.fields}`,
            codec: { kind: "dropValues", values: ["color"] },
          };
        }
        return { ...op, path: `/${n.num}` };
      case "add":
        return { ...op, path: `/${n.added}` };
      case "remove":
        return { ...op, path: `/${n.enum}` };
      case "default":
        return { ...op, path: `/${n.num}`, toward: "new" };
      case "dropNull":
        return { ...op, path: `/${n.enum}`, toward: "new" };
      case "relax":
        // A parameter is only sent, so only a bound that widens can be served.
        return { ...op, path: `/${n.num}`, set: { maximum: null } };
      default:
        return op;
    }
  });
  try {
    return parseChange({
      ...change,
      scopes: [{ operation: "listOrders", location }],
      ops,
    });
  } catch {
    return undefined;
  }
}

function fitTo(change: Change, name: string): fc.Arbitrary<Change | undefined> {
  const schema = schemas[name] as Schema;
  const fields = fieldsOf(schema);
  const pick = (candidates: Field[]) =>
    candidates.length === 0 ? fc.constant(undefined) : fc.constantFrom(...candidates);
  const ops = change.ops.map((op): fc.Arbitrary<unknown> => {
    switch (op.op) {
      case "move":
        return pick(fields.filter((field) => !field.pointer.includes("/", 1))).map(
          (field) =>
            field ? { ...op, from: field.pointer, to: `${field.pointer}_renamed` } : op,
        );
      case "remove":
        return pick(fields.filter((field) => !field.required)).map((field) =>
          field ? { ...op, path: field.pointer } : op,
        );
      case "add":
        return fc.constant({ ...op, path: "/added_field", value: "supplied" });
      case "default":
        // Facing whichever side the scope is used on, so it has work to do.
        return pick(fields).map((field) =>
          field
            ? {
                ...op,
                path: field.pointer,
                toward: name === "OrderCreate" ? "new" : "old",
              }
            : op,
        );
      case "dropNull":
        // Only a field that may be left out can have its null left out.
        return pick(fields.filter((field) => !field.required)).map((field) =>
          field
            ? {
                ...op,
                path: field.pointer,
                toward: name === "OrderCreate" ? "new" : "old",
              }
            : op,
        );
      case "relax":
        // A bound taken away, which widens on either side and so is served
        // wherever the schema is used.
        return pick(
          fields.filter((field) => field.type === "integer" || field.type === "number"),
        ).map((field) =>
          field ? { ...op, path: field.pointer, set: { maximum: null } } : op,
        );
      case "convert": {
        const codec = op.codec;
        if (codec.kind === "scale10") {
          return pick(fields.filter((field) => field.type === "number")).map((field) =>
            field ? { ...op, path: field.pointer } : op,
          );
        }
        if (codec.kind === "enumMap") {
          return pick(fields.filter((field) => field.enum)).map((field) =>
            field
              ? {
                  ...op,
                  path: field.pointer,
                  codec: {
                    kind: "enumMap",
                    pairs: (field.enum as string[]).map((value) => [
                      value,
                      `${value}_now`,
                    ]),
                    // A value only the new contract has, shown to an old
                    // caller as one they know: the commonest enum break.
                    ...(codec.fold
                      ? { fold: [["refunded_now", `${(field.enum as string[])[0]}_now`]] }
                      : {}),
                  },
                }
              : op,
          );
        }
        if (codec.kind === "dateFormat") {
          // A count of seconds that becomes text, or text that becomes one.
          return pick(
            fields.filter((field) => field.type === "integer" || field.type === "string"),
          ).map((field) =>
            field
              ? {
                  ...op,
                  path: field.pointer,
                  codec:
                    field.type === "integer"
                      ? { kind: "dateFormat", from: "epoch-s", to: "rfc3339" }
                      : { kind: "dateFormat", from: "rfc3339", to: "epoch-ms" },
                }
              : op,
          );
        }
        if (codec.kind === "stringCase") {
          return pick(fields.filter((field) => field.enum)).map((field) =>
            field
              ? {
                  ...op,
                  path: field.pointer,
                  codec: { kind: "stringCase", from: "snake", to: "screaming" },
                }
              : op,
          );
        }
        if (codec.kind === "dropValues") {
          return fc.constant({
            ...op,
            path: "/flags",
            codec: { kind: "dropValues", values: ["rush"] },
          });
        }
        if (codec.kind === "wrapArray" || codec.kind === "unwrapSingle") {
          const list = codec.kind === "unwrapSingle";
          return pick(fields.filter((field) => (field.type === "array") === list)).map(
            (field) => (field ? { ...op, path: field.pointer } : op),
          );
        }
        // A cast from the field's own type to any other.
        return pick(
          fields.filter((field) => !field.enum && field.type !== "array"),
        ).chain((field) =>
          field
            ? fc
                .constantFrom("string", "integer", "number", "boolean")
                .filter((to) => to !== field.type)
                .map(
                  (to): ConvertOp => ({
                    ...op,
                    path: field.pointer,
                    codec: { kind: "cast", from: field.type as ScalarType, to },
                  }),
                )
            : fc.constant(op),
        );
      }
      default:
        return fc.constant(op);
    }
  });
  return fc.tuple(...ops).map((fitted) => {
    try {
      return parseChange({
        ...change,
        scopes: [{ schema: `#/components/schemas/${name}` }],
        ops: fitted,
      });
    } catch {
      return undefined;
    }
  });
}

// Mostly fitted, so every op kind reaches the path where it is served; the
// rest unfitted, so the paths where the gate blocks stay exercised too.
const GENERATED = fc.oneof(
  { weight: 1, arbitrary: CHANGE },
  { weight: 4, arbitrary: CHANGE.chain(fit) },
);

/** Whether the program carries work for every op of the Change. */
function unserved(change: Change, program: unknown): string[] {
  const { contracts, blocks } = program as {
    contracts: Record<string, Schema>;
    blocks?: Schema;
  };
  const contract = contracts["old"] ?? {};
  // A schema's blocks are shared by every contract, so they are held once, at
  // the top of the program.
  const text = JSON.stringify({ contract, blocks });
  const mentions = (text.match(new RegExp(`"c":"${change.id}"`, "g")) ?? []).length;
  const missing: string[] = [];
  // An op with nothing to do in the direction a site faces is a correct
  // program rather than a missing one: a field that may no longer be null
  // needs nothing on the way back to a caller who never saw a null.
  // A payload the provider sends is undone as a response is.
  const actsOn = (op: Change["ops"][number], travels: string) => {
    const direction = travels === "outbound" ? "response" : travels;
    return op.op === "dropNull" || op.op === "default"
      ? direction === (op.toward === "new" ? "request" : "response")
      : op.op === "widen"
        ? direction === "response"
        : // A field dropped with nothing to put back is only taken out of
          // requests; old callers' responses were never promised it.
          (op.op === "remove" && op.restore === undefined) ||
            // A list an old caller is sent is the new contract's to fill.
            (op.op === "convert" && op.codec.kind === "dropValues")
          ? direction === "request"
          : op.op !== "relax" && op.op !== "restate";
  };
  const dataOps = change.ops.filter(isDataOp);
  const parameterScoped = (change.scopes ?? []).some((scope) => "location" in scope);
  const responseScoped = (change.scopes ?? []).filter(
    (scope): scope is { operation: string; response: string } => "response" in scope,
  );
  if (dataOps.length > 0 && responseScoped.length > 0) {
    // Each response the Change names needs work in that response's program
    // for every op that acts on the way back.
    const acting = dataOps.filter((op) => actsOn(op, "response"));
    // Filed under the endpoint a call arrives at, which a route in the same
    // Change may have moved, so every site is searched.
    const sites = Object.values(
      (contract["sites"] ?? {}) as Record<string, { response?: Record<string, unknown> }>,
    );
    for (const scope of responseScoped) {
      const found = sites.some((site) =>
        JSON.stringify(site.response?.[scope.response] ?? []).includes(
          `"c":"${change.id}"`,
        ),
      );
      if (acting.length > 0 && !found) {
        missing.push(`${scope.operation} ${scope.response}: no response instructions`);
      }
    }
  } else if (dataOps.length > 0 && parameterScoped) {
    // A parameter only exists on the way in, so every op that faces new has
    // to have left a request instruction: in the operation's envelope, or,
    // for a scope on the operation's own body alone, in its body program.
    // A bound, or the same values restated, is served by leaving the value
    // alone, so it leaves no work.
    const facing = dataOps.filter(
      (op) =>
        op.op !== "relax" &&
        op.op !== "restate" &&
        !((op.op === "default" || op.op === "dropNull") && op.toward === "old"),
    );
    const requests = Object.values(
      (contract["sites"] ?? {}) as Record<
        string,
        { envelope?: unknown; request?: unknown }
      >,
    ).map((site) => JSON.stringify([site.envelope ?? null, site.request ?? null]));
    const onTheWayIn = requests.join().split(`"c":"${change.id}"`).length - 1;
    if (facing.length > 0 && onTheWayIn < facing.length) {
      missing.push(`${facing.length} parameter ops, ${onTheWayIn} request instructions`);
    }
  } else if (dataOps.length > 0) {
    const sites = (change.scopes ?? [])
      .flatMap((scope) =>
        "schema" in scope ? findSchemaSites(OLD, scope.schema).sites : [],
      )
      .filter((site) => dataOps.some((op) => actsOn(op, site.direction)));
    // Every site a data op reaches needs at least one instruction per op.
    if (sites.length > 0 && mentions < sites.length) {
      missing.push(`${sites.length} sites, ${mentions} instructions`);
    }
    // A Change whose data ops can reach nothing has nothing to serve only if
    // it named a schema the contract has and nothing uses; anything else is a
    // Change pointed at nowhere, which must not pass as served.
    const named = (change.scopes ?? []).filter((scope) => "schema" in scope);
    if (named.length === 0) missing.push("data ops with no schema to apply to");
    for (const scope of named) {
      const name = (scope as { schema: string }).schema.split("/").pop() as string;
      if (!(name in schemas)) missing.push(`scope ${name} is not in the contract`);
    }
  }
  for (const op of change.ops) {
    if (op.op === "behavior" && !text.includes(`"${op.flag}"`)) missing.push("behavior");
    // A route to where the operation already is moves nothing, so has nothing
    // to serve.
    const identity =
      op.op === "route" && op.from.method === op.to.method && op.from.path === op.to.path;
    if ((op.op === "route" || op.op === "retire") && !identity && mentions === 0) {
      missing.push(op.op);
    }
  }
  return missing;
}

/** One of every data op on the schema that contains itself, which random pointers rarely hit. */
const THREAD_OPS: Change["ops"] = [
  { op: "move", from: "/title", to: "/name" },
  {
    op: "convert",
    path: "/status",
    codec: {
      kind: "enumMap",
      pairs: [
        ["pending", "paid"],
        ["paid", "pending"],
        ["void", "void"],
      ],
    },
  },
  {
    op: "convert",
    path: "/count",
    codec: { kind: "cast", from: "integer", to: "string" },
  },
  {
    op: "convert",
    path: "/count",
    codec: { kind: "dateFormat", from: "epoch-s", to: "rfc3339" },
  },
  {
    op: "convert",
    path: "/status",
    codec: { kind: "stringCase", from: "snake", to: "screaming" },
  },
  { op: "convert", path: "/title", codec: { kind: "wrapArray" } },
  { op: "convert", path: "/replies", codec: { kind: "unwrapSingle" } },
  { op: "add", path: "/label", value: "x" },
  { op: "relax", path: "/count", set: { maximum: null } },
  { op: "restate", path: "/status" },
  { op: "remove", path: "/title", restore: "x" },
  { op: "default", path: "/title", value: "x", when: "absent", toward: "new" },
  { op: "dropNull", path: "/title", toward: "old" },
];

describe("L1: a Change the runtime cannot serve never passes the gate", () => {
  it("compiles to work for every op, or reports why it cannot", () => {
    // What passed the gate, by op kind: a property that only ever saw blocked
    // Changes would prove nothing about the ones that pass.
    const passed = new Map<string, number>();
    fc.assert(
      fc.property(GENERATED, (change) => {
        if (!change) return;
        // Modelled on the gate in the CLI's check: a release fails on any
        // prediction issue, and on any projection issue from the chain.
        let prediction: ReturnType<typeof predictDocument>;
        try {
          prediction = predictDocument(OLD, NEW, [change]);
        } catch {
          // A Change that cannot even be applied to the contract is refused
          // before anything is compiled.
          return;
        }
        if (prediction.issues.length > 0) return;
        const chained = chainProgram("acme", "new", "sha256:l1", [
          {
            label: "new",
            parent: "old",
            from: OLD,
            to: prediction.document,
            changes: [change],
          },
        ]);
        if (chained.issues.length > 0) return;
        for (const op of change.ops) {
          const kind = op.op === "convert" ? `convert ${op.codec.kind}` : op.op;
          passed.set(kind, (passed.get(kind) ?? 0) + 1);
        }
        if ((change.scopes ?? []).some((scope) => "location" in scope)) {
          passed.set("parameters", (passed.get("parameters") ?? 0) + 1);
        }
        if ((change.scopes ?? []).some((scope) => "response" in scope)) {
          passed.set("response bodies", (passed.get("response bodies") ?? 0) + 1);
        }
        if (chained.program.blocks) {
          passed.set("shared blocks", (passed.get("shared blocks") ?? 0) + 1);
        }
        expect(unserved(change, chained.program), JSON.stringify(change)).toEqual([]);
      }),
      // A fixed seed on every commit, so the coverage asserted below cannot
      // come and go with the seed; the nightly run passes FUZZ_SEED.
      {
        numRuns: Number(process.env["FUZZ_RUNS"] ?? 2000),
        seed: Number(process.env["FUZZ_SEED"] ?? 1),
        // Found by the nightly run: a Change on the operation's own body is
        // served by its body program, not its envelope.
        examples: [
          [
            {
              irVersion: 1,
              id: "chg_generated",
              summary: "paid",
              scopes: [{ operation: "createOrder", location: "body" }],
              ops: [{ op: "add", path: "/shipping/zip", value: "x" }],
            } as Change,
          ],
          // A union that gained a kind of value: rarely generated at random,
          // since it needs the union's place and the new variant together.
          [
            {
              irVersion: 1,
              id: "chg_generated",
              summary: "paid",
              scopes: [{ schema: "#/components/schemas/Order" }],
              ops: [
                {
                  op: "widen",
                  path: "/customer",
                  variant: "#/components/schemas/Guest",
                  show: "id",
                },
              ],
            } as Change,
          ],
          // A schema that contains itself: every data op, through the blocks.
          ...THREAD_OPS.map((op): [Change] => [
            {
              irVersion: 1,
              id: "chg_generated",
              summary: "paid",
              scopes: [{ schema: "#/components/schemas/Thread" }],
              ops: [op],
            } as Change,
          ]),
        ],
      },
    );
    console.log(`passed the gate, by op: ${JSON.stringify(Object.fromEntries(passed))}`);
    for (const kind of [
      "move",
      "convert scale10",
      "convert enumMap",
      "convert cast",
      "convert dateFormat",
      "convert stringCase",
      "convert wrapArray",
      "convert unwrapSingle",
      "convert dropValues",
      "add",
      "remove",
      "default",
      "dropNull",
      "widen",
      "relax",
      "restate",
      "route",
      "retire",
      "behavior",
      "parameters",
      "response bodies",
      "shared blocks",
    ]) {
      expect(passed.get(kind) ?? 0, kind).toBeGreaterThan(0);
    }
  });
});

/**
 * The matrix, executed: a Change for every cell, and the compiler has to do
 * what the cell says. A cell nobody filled in fails, so a new op kind or a
 * new place in a message cannot arrive without someone deciding what the
 * gate does with it.
 */
describe("L1: the op x location x direction matrix", () => {
  const matrix = JSON.parse(
    readFileSync(new URL("../matrix.json", import.meta.url), "utf8"),
  ) as {
    locations: string[];
    directions: string[];
    ops: string[];
    cells: Record<string, { status: string; why: string }>;
    endpoint: Record<string, { status: string; why: string }>;
    /** `op direction` cells where the op is served by doing nothing. */
    inert: Record<string, string>;
  };

  const bodyOps: Record<string, unknown> = {
    move: { op: "move", from: "/note", to: "/memo" },
    "convert scale10": {
      op: "convert",
      path: "/amount",
      codec: { kind: "scale10", exponent: 2, onInexact: "reject" },
    },
    "convert enumMap": {
      op: "convert",
      path: "/status",
      codec: {
        kind: "enumMap",
        pairs: [
          ["pending", "open"],
          ["paid", "settled"],
          ["void", "cancelled"],
        ],
      },
    },
    "convert cast": {
      op: "convert",
      path: "/count",
      codec: { kind: "cast", from: "integer", to: "string" },
    },
    "convert dateFormat": {
      op: "convert",
      path: "/count",
      codec: { kind: "dateFormat", from: "epoch-s", to: "rfc3339" },
    },
    "convert stringCase": {
      op: "convert",
      path: "/status",
      codec: { kind: "stringCase", from: "snake", to: "screaming" },
    },
    "convert wrapArray": { op: "convert", path: "/note", codec: { kind: "wrapArray" } },
    "convert unwrapSingle": {
      op: "convert",
      path: "/tags",
      codec: { kind: "unwrapSingle" },
    },
    add: { op: "add", path: "/added_field", value: "supplied" },
    remove: { op: "remove", path: "/note", restore: "" },
    default: { op: "default", path: "/note", value: "", when: "absent-or-null" },
    dropNull: { op: "dropNull", path: "/note" },
    widen: {
      op: "widen",
      path: "/customer",
      variant: "#/components/schemas/Guest",
      show: "id",
    },
    relax: { op: "relax", path: "/count", set: { maximum: null } },
    restate: { op: "restate", path: "/note" },
    "convert dropValues": {
      op: "convert",
      path: "/flags",
      codec: { kind: "dropValues", values: ["rush"] },
    },
  };
  /** The op as it would be written for a body used in this direction. */
  const bodyOp = (op: string, direction: string) =>
    op === "default" || op === "dropNull"
      ? { ...(bodyOps[op] as object), toward: direction === "request" ? "new" : "old" }
      : bodyOps[op];
  const parameterOp = (op: string, location: string): unknown => {
    const n = NAMES[location] as (typeof NAMES)[string];
    switch (op) {
      case "move":
        return { op: "move", from: `/${n.num}`, to: `/${n.renamed}` };
      case "convert scale10":
        return {
          op: "convert",
          path: `/${n.num}`,
          codec: { kind: "scale10", exponent: 1, onInexact: "reject" },
        };
      case "convert enumMap":
        return {
          op: "convert",
          path: `/${n.enum}`,
          codec: {
            kind: "enumMap",
            pairs: [
              ["asc", "ascending"],
              ["desc", "descending"],
            ],
          },
        };
      case "convert cast":
        return {
          op: "convert",
          path: `/${n.num}`,
          codec: {
            kind: "cast",
            from: location === "path" ? "string" : "integer",
            to: location === "path" ? "integer" : "string",
          },
        };
      case "convert dateFormat":
        return {
          op: "convert",
          path: `/${n.num}`,
          codec:
            location === "path"
              ? { kind: "dateFormat", from: "rfc3339", to: "epoch-s" }
              : { kind: "dateFormat", from: "epoch-s", to: "rfc3339" },
        };
      case "convert stringCase":
        return {
          op: "convert",
          path: `/${n.enum}`,
          codec: { kind: "stringCase", from: "snake", to: "screaming" },
        };
      case "convert wrapArray":
        return { op: "convert", path: `/${n.num}`, codec: { kind: "wrapArray" } };
      case "convert unwrapSingle":
        return { op: "convert", path: `/${n.list}`, codec: { kind: "unwrapSingle" } };
      case "convert dropValues":
        return {
          op: "convert",
          path: `/${n.fields}`,
          codec: { kind: "dropValues", values: ["color"] },
        };
      case "add":
        return { op: "add", path: `/${n.added}`, value: "start" };
      case "remove":
        return { op: "remove", path: `/${n.enum}`, restore: "asc" };
      case "default":
        return {
          op: "default",
          path: `/${n.num}`,
          value: 10,
          when: "absent",
          toward: "new",
        };
      case "widen":
        return {
          op: "widen",
          path: `/${n.enum}`,
          variant: "#/components/schemas/Guest",
          show: "id",
        };
      case "relax":
        return { op: "relax", path: `/${n.num}`, set: { maximum: null } };
      case "restate":
        return { op: "restate", path: `/${n.num}` };
      default:
        return { op: "dropNull", path: `/${n.enum}`, toward: "new" };
    }
  };

  const outcome = (change: Change) => {
    const prediction = predictDocument(OLD, NEW, [change]);
    const chained = chainProgram("acme", "new", "sha256:matrix", [
      {
        label: "new",
        parent: "old",
        from: OLD,
        to: prediction.document,
        changes: [change],
      },
    ]);
    return {
      blocked: prediction.issues.length > 0 || chained.issues.length > 0,
      issues: [...prediction.issues, ...chained.issues].map((issue) => issue.message),
      contract: (chained.program as unknown as { contracts: Record<string, Schema> })
        .contracts["old"] as Schema,
    };
  };

  it("has a status for every cell", () => {
    for (const location of matrix.locations) {
      for (const direction of matrix.directions) {
        expect(
          matrix.cells[`${location} ${direction}`],
          `${location} ${direction}`,
        ).toBeDefined();
      }
    }
    for (const op of ["route", "retire", "behavior"]) {
      expect(matrix.endpoint[op], op).toBeDefined();
    }
    // Every op kind and codec the IR can express is in the matrix, read from
    // the IR's own schema so a new one cannot slip past.
    const change = (irJsonSchemas()["$defs"] as Record<string, Schema>)[
      "Change"
    ] as Schema;
    const ops = (((change["properties"] as Schema)["ops"] as Schema)["items"] as Schema)[
      "anyOf"
    ] as Schema[];
    const kinds = ops.flatMap((op) => {
      const name = ((op["properties"] as Schema)["op"] as Schema)["const"] as string;
      if (name !== "convert") return [name];
      const codecs = ((op["properties"] as Schema)["codec"] as Schema)[
        "anyOf"
      ] as Schema[];
      return codecs.map(
        (codec) =>
          `convert ${((codec["properties"] as Schema)["kind"] as Schema)["const"]}`,
      );
    });
    expect(kinds.length).toBeGreaterThan(5);
    for (const kind of kinds) {
      expect(
        matrix.ops.includes(kind) || matrix.endpoint[kind] !== undefined,
        `${kind} is not in matrix.json`,
      ).toBe(true);
    }
  });

  for (const op of matrix.ops) {
    for (const direction of ["request", "response", "outbound"]) {
      it(`${op} in a body, ${direction}: ${"served"}`, () => {
        expect(matrix.cells[`body ${direction}`]?.status).toBe("served");
        // OrderCreate reaches request bodies only, Order response bodies
        // only, OrderEvent a webhook's payload only.
        const schema =
          direction === "request"
            ? "OrderCreate"
            : direction === "response"
              ? "Order"
              : "OrderEvent";
        const change = parseChange({
          irVersion: 1,
          id: "chg_cell",
          summary: "a cell",
          scopes: [{ schema: `#/components/schemas/${schema}` }],
          ops: [bodyOp(op, direction)],
        });
        const result = outcome(change);
        expect(result.issues).toEqual([]);
        const sites = Object.values(
          (result.contract["sites"] ?? {}) as Record<string, Schema>,
        );
        const reached =
          direction === "outbound"
            ? JSON.stringify(result.contract["outbound"] ?? {}).includes('"c":"chg_cell"')
            : sites.some((site) =>
                JSON.stringify(
                  direction === "request" ? site["request"] : site["response"],
                )?.includes('"c":"chg_cell"'),
              );
        // An op with nothing to do in a direction is served by doing nothing,
        // and the matrix says which those are.
        expect(reached).toBe(matrix.inert[`${op} ${direction}`] === undefined);
      });
    }
    for (const location of ["query", "header", "cookie", "path"]) {
      const cell = matrix.cells[`${location} request`] as {
        status: string;
        only?: string[];
        except?: string[];
      };
      const served =
        cell.status === "served" &&
        (!cell.only || cell.only.includes(op)) &&
        !cell.except?.includes(op);
      // A path parameter the fixture declares is a string, so only a cast
      // lands on it; scale and enum are the same instruction and covered there.
      if (location === "path" && (op === "convert scale10" || op === "convert enumMap")) {
        continue;
      }
      it(`${op} in a ${location} parameter, request: ${served ? "served" : "blocked"}`, () => {
        const change = parseChange({
          irVersion: 1,
          id: "chg_cell",
          summary: "a cell",
          scopes: [
            {
              operation: location === "path" ? "getOrder" : "listOrders",
              location,
            },
          ],
          ops: [parameterOp(op, location)],
        });
        const result = outcome(change);
        if (!served) {
          expect(result.blocked).toBe(true);
          return;
        }
        expect(result.issues).toEqual([]);
        const sites = Object.values(
          (result.contract["sites"] ?? {}) as Record<string, Schema>,
        );
        expect(
          sites.some((site) =>
            JSON.stringify(site["envelope"])?.includes('"c":"chg_cell"'),
          ),
        ).toBe(matrix.inert[`${op} request`] === undefined);
      });
    }
  }

  it("refuses a header that carries a credential", () => {
    const change = parseChange({
      irVersion: 1,
      id: "chg_cell",
      summary: "a cell",
      scopes: [{ operation: "listOrders", location: "header" }],
      ops: [{ op: "move", from: "/Authorization", to: "/X-Limit" }],
    });
    const result = outcome(change);
    expect(result.blocked).toBe(true);
    expect(result.issues.join()).toContain("authorization header");
  });

  it("cannot express a parameter in a response", () => {
    for (const location of ["query", "path", "header", "cookie"]) {
      expect(matrix.cells[`${location} response`]?.status).toBe("not expressible");
    }
    // If the IR grows a way to scope a response header, this fails, and the
    // matrix has to say what the gate does with it.
    expect(() =>
      parseChange({
        irVersion: 1,
        id: "chg_cell",
        summary: "a cell",
        scopes: [{ operation: "getOrder", location: "header", direction: "response" }],
        ops: [{ op: "remove", path: "/x-rate", restore: "" }],
      }),
    ).toThrow();
  });

  it("serves the endpoint ops", () => {
    for (const [name, op] of Object.entries({
      route: {
        op: "route",
        from: { method: "post", path: "/v1/refunds" },
        to: { method: "post", path: "/v1/orders/{id}/refunds" },
      },
      retire: { op: "retire", endpoint: { method: "post", path: "/v1/refunds" } },
      behavior: { op: "behavior", flag: "refunds_are_async" },
    })) {
      expect(matrix.endpoint[name]?.status).toBe("served");
      const result = outcome(
        parseChange({ irVersion: 1, id: "chg_cell", summary: "a cell", ops: [op] }),
      );
      expect(result.issues, name).toEqual([]);
      expect(JSON.stringify(result.contract), name).toMatch(/chg_cell|refunds_are_async/);
    }
  });
});
