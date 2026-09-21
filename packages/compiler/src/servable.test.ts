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
import { findSchemaSites, type OpenApiDocument } from "@invariant/contract";
import {
  type Change,
  type ConvertOp,
  irJsonSchemas,
  isDataOp,
  parseChange,
  type ScalarType,
} from "@invariant/ir";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { predictDocument } from "./predict.ts";

/**
 * A contract with every kind of field a data op can meet, each used in a
 * request body, a response body and a list, so every op kind has somewhere
 * real to land.
 */
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
          shipping: {
            type: "object",
            properties: { city: { type: "string" }, zip: { type: "string" } },
          },
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
          shipping: {
            type: "object",
            properties: { city: { type: "string" }, zip: { type: "string" } },
          },
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
    },
  },
} as unknown as OpenApiDocument;

type Schema = Record<string, unknown>;

/**
 * The new contract: the old one with a field only it has, since `add` takes
 * the added field's schema from the contract it is adding for.
 */
const NEW = structuredClone(OLD) as OpenApiDocument;
for (const name of ["Order", "OrderCreate"]) {
  const schema = (NEW["components"] as { schemas: Record<string, Schema> }).schemas[
    name
  ] as Schema;
  (schema["properties"] as Record<string, unknown>)["added_field"] = { type: "string" };
}

const schemas = (OLD["components"] as { schemas: Record<string, Schema> }).schemas;
const SCHEMA_REFS = [
  ...Object.keys(schemas).map((name) => `#/components/schemas/${name}`),
  "#/components/schemas/NotInTheContract",
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
        : typeof child["type"] === "string" && child["type"] !== "array"
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
 * The same Change with its data ops pointed at fields of its own scope that
 * suit them: a scale at a number, an enum map over the field's real values, a
 * cast from the field's own type. Without this, random leaves almost never
 * line up, and the converts never reach the path where they would be served.
 */
function fit(change: Change | undefined): fc.Arbitrary<Change | undefined> {
  if (!change?.ops.some(isDataOp)) return fc.constant(change);
  // One schema the contract uses, in place of whatever scopes were drawn: a
  // stray parameter scope would block the Change before it could be served.
  return fc.constantFrom("Order", "OrderCreate").chain((name) => fitTo(change, name));
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
        // A cast from the field's own type to any other.
        return pick(fields.filter((field) => !field.enum)).chain((field) =>
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
  const contract =
    (program as { contracts: Record<string, Schema> }).contracts["old"] ?? {};
  const text = JSON.stringify(contract);
  const mentions = (text.match(new RegExp(`"c":"${change.id}"`, "g")) ?? []).length;
  const missing: string[] = [];
  const dataOps = change.ops.filter(isDataOp);
  if (dataOps.length > 0) {
    const sites = (change.scopes ?? []).flatMap((scope) =>
      "schema" in scope ? findSchemaSites(OLD, scope.schema).sites : [],
    );
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
        expect(unserved(change, chained.program), JSON.stringify(change)).toEqual([]);
      }),
      // A fixed seed on every commit, so the coverage asserted below cannot
      // come and go with the seed; the nightly run passes FUZZ_SEED.
      {
        numRuns: Number(process.env["FUZZ_RUNS"] ?? 2000),
        seed: Number(process.env["FUZZ_SEED"] ?? 1),
      },
    );
    console.log(`passed the gate, by op: ${JSON.stringify(Object.fromEntries(passed))}`);
    for (const kind of [
      "move",
      "convert scale10",
      "convert enumMap",
      "convert cast",
      "add",
      "remove",
      "route",
      "retire",
      "behavior",
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
    add: { op: "add", path: "/added_field", value: "supplied" },
    remove: { op: "remove", path: "/note", restore: "" },
  };
  const parameterOps: Record<string, unknown> = {
    move: { op: "move", from: "/limit", to: "/page_size" },
    "convert scale10": {
      op: "convert",
      path: "/limit",
      codec: { kind: "scale10", exponent: 1, onInexact: "reject" },
    },
    "convert enumMap": {
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
    "convert cast": {
      op: "convert",
      path: "/limit",
      codec: { kind: "cast", from: "integer", to: "string" },
    },
    add: { op: "add", path: "/cursor", value: "start" },
    remove: { op: "remove", path: "/sort", restore: "asc" },
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

  for (const op of [
    "move",
    "convert scale10",
    "convert enumMap",
    "convert cast",
    "add",
    "remove",
  ]) {
    for (const direction of ["request", "response"]) {
      it(`${op} in a body, ${direction}: ${"served"}`, () => {
        expect(matrix.cells[`body ${direction}`]?.status).toBe("served");
        // OrderCreate reaches request bodies only, Order response bodies only.
        const schema = direction === "request" ? "OrderCreate" : "Order";
        const change = parseChange({
          irVersion: 1,
          id: "chg_cell",
          summary: "a cell",
          scopes: [{ schema: `#/components/schemas/${schema}` }],
          ops: [bodyOps[op]],
        });
        const result = outcome(change);
        expect(result.issues).toEqual([]);
        const sites = Object.values(
          (result.contract["sites"] ?? {}) as Record<string, Schema>,
        );
        const reached = sites.some((site) =>
          JSON.stringify(
            direction === "request" ? site["request"] : site["response"],
          )?.includes('"c":"chg_cell"'),
        );
        expect(reached).toBe(true);
      });
    }
    for (const location of ["query", "header", "path"]) {
      it(`${op} in a ${location} parameter, request: ${matrix.cells[`${location} request`]?.status}`, () => {
        expect(matrix.cells[`${location} request`]?.status).toBe("blocked");
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
          ops: [parameterOps[op]],
        });
        expect(outcome(change).blocked).toBe(true);
      });
    }
  }

  it("cannot express a parameter in a response", () => {
    for (const location of ["query", "path", "header"]) {
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
