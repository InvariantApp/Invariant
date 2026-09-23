/**
 * A field that became optional, nullable, required or not nullable.
 *
 * The prediction has to reproduce the new contract exactly, written the way
 * the document's own version writes nullability, or closure would report a
 * change nobody made. The program has to fill in only on the side that needs
 * it, and never overwrite a value the other side was entitled to send.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { type Change, type JsonObject, parseChange } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { derive } from "./derive.ts";
import { predictDocument } from "./predict.ts";
import { instrsFor } from "./project.ts";

type Schema = Record<string, unknown>;

function contract(version: string, schemas: Record<string, Schema>): OpenApiDocument {
  const body = (name: string) => ({
    content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
  });
  return {
    openapi: version,
    info: { title: "t", version: "1" },
    paths: {
      "/things": {
        post: {
          operationId: "createThing",
          requestBody: body("ThingCreate"),
          responses: { "201": { description: "made", ...body("Thing") } },
        },
      },
    },
    components: { schemas },
  } as unknown as OpenApiDocument;
}

const change = (schema: string, op: Schema): Change =>
  parseChange({
    irVersion: 1,
    id: "chg_nullability",
    summary: "nullability",
    scopes: [{ schema: `#/components/schemas/${schema}` }],
    ops: [op],
  });

const predicted = (before: OpenApiDocument, changes: Change[]) => {
  const prediction = predictDocument(before, before, changes);
  expect(prediction.issues).toEqual([]);
  return (prediction.document["components"] as JsonObject)["schemas"];
};

const thing = (properties: Schema, required: string[]): Schema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});

describe("a response field that may now be left out or null", () => {
  const before30 = contract("3.0.3", {
    ThingCreate: thing({ name: { type: "string" } }, []),
    Thing: thing({ id: { type: "string" }, region: { type: "string" } }, [
      "id",
      "region",
    ]),
  });

  it("is predicted optional and nullable in 3.0's own spelling", () => {
    const op = {
      op: "default",
      path: "/region",
      value: "us",
      when: "absent-or-null",
      toward: "old",
    };
    expect(predicted(before30, [change("Thing", op)])).toEqual({
      ThingCreate: thing({ name: { type: "string" } }, []),
      Thing: thing(
        { id: { type: "string" }, region: { type: "string", nullable: true } },
        ["id"],
      ),
    });
  });

  it("is predicted nullable in 3.1's own spelling", () => {
    const before31 = contract("3.1.0", {
      ThingCreate: thing({ name: { type: "string" } }, []),
      Thing: thing({ region: { type: "string" } }, ["region"]),
    });
    const op = {
      op: "default",
      path: "/region",
      value: "us",
      when: "null",
      toward: "old",
    };
    expect((predicted(before31, [change("Thing", op)]) as JsonObject)["Thing"]).toEqual(
      thing({ region: { type: ["string", "null"] } }, ["region"]),
    );
  });

  it("is predicted as a union with null where the new contract writes it so (Mistral)", () => {
    // Mistral's document owner went from a `uuid` string to `anyOf` that
    // string or null. Written as a list of types, the prediction meant the
    // same and the differ read it as the owner's types widening.
    const version = (owner: Schema) =>
      contract("3.1.0", {
        ThingCreate: thing({ name: { type: "string" } }, []),
        Thing: thing({ owner }, ["owner"]),
      });
    const before = version({ type: "string", format: "uuid", title: "Owner" });
    const after = version({
      anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      title: "Owner",
    });
    const op = { op: "default", path: "/owner", value: "", when: "null", toward: "old" };
    const prediction = predictDocument(before, after, [change("Thing", op)]);
    expect(prediction.issues).toEqual([]);
    const schemas = (prediction.document["components"] as JsonObject)["schemas"];
    expect((schemas as JsonObject)["Thing"]).toEqual(
      ((after["components"] as JsonObject)["schemas"] as JsonObject)["Thing"],
    );
  });

  it("is predicted in responses alone where old callers send the schema too (Adyen)", () => {
    // Adyen kept `supportUrl` required where a payment method is set up, and
    // made it optional where one is returned. Loosening the schema both share
    // said requests could leave it out, which they cannot.
    const info = thing({ supportUrl: { type: "string" } }, ["supportUrl"]);
    const before = contract("3.0.3", {
      ThingCreate: thing({ info: { $ref: "#/components/schemas/Info" } }, []),
      Thing: thing({ info: { $ref: "#/components/schemas/Info" } }, ["info"]),
      Info: info,
    });
    const op = {
      op: "default",
      path: "/supportUrl",
      value: "",
      when: "absent",
      toward: "old",
    };
    const prediction = predictDocument(before, before, [change("Info", op)]);
    expect(prediction.issues).toEqual([]);
    const document = prediction.document as JsonObject;
    // What old callers send is as it was.
    expect(
      ((document["components"] as JsonObject)["schemas"] as JsonObject)["Info"],
    ).toEqual(info);
    // What they are sent, in that response's own copy, may leave it out.
    const created = ((document["paths"] as JsonObject)["/things"] as JsonObject)[
      "post"
    ] as JsonObject;
    const body = (
      ((created["responses"] as JsonObject)["201"] as JsonObject)["content"] as JsonObject
    )["application/json"] as JsonObject;
    expect((body["schema"] as JsonObject)["properties"]).toEqual({
      info: { type: "object", properties: { supportUrl: { type: "string" } } },
    });
  });

  it("is predicted in the schema they share where the new contract loosened requests too", () => {
    const info = (required: string[]) =>
      thing({ supportUrl: { type: "string" } }, required);
    const version = (required: string[]) =>
      contract("3.0.3", {
        ThingCreate: thing({ info: { $ref: "#/components/schemas/Info" } }, []),
        Thing: thing({ info: { $ref: "#/components/schemas/Info" } }, ["info"]),
        Info: info(required),
      });
    const op = {
      op: "default",
      path: "/supportUrl",
      value: "",
      when: "absent",
      toward: "old",
    };
    const prediction = predictDocument(version(["supportUrl"]), version([]), [
      change("Info", op),
    ]);
    expect(prediction.issues).toEqual([]);
    expect(
      ((prediction.document["components"] as JsonObject)["schemas"] as JsonObject)[
        "Info"
      ],
    ).toEqual(info([]));
  });

  it("is filled in for old callers only, and only where the new side left it so", () => {
    const op = {
      op: "default",
      path: "/region",
      value: "us",
      when: "absent-or-null",
      toward: "old",
    };
    const { forward, backward } = instrsFor(change("Thing", op));
    expect(forward).toEqual([]);
    expect(backward).toEqual([
      {
        k: "set",
        path: "/region",
        value: "us",
        ifAbsent: true,
        ifNull: true,
        c: "chg_nullability",
      },
    ]);
    const onlyNull = instrsFor(change("Thing", { ...op, when: "null" })).backward[0];
    expect(onlyNull).toMatchObject({ ifAbsent: false, ifNull: true });
    const onlyAbsent = instrsFor(change("Thing", { ...op, when: "absent" })).backward[0];
    expect(onlyAbsent).toMatchObject({ ifAbsent: true });
    expect(onlyAbsent).not.toHaveProperty("ifNull");
  });

  it("is declared lossy on the way back to the old caller", () => {
    const op = {
      op: "default",
      path: "/region",
      value: "us",
      when: "null",
      toward: "old",
    };
    const derived = derive(change("Thing", op));
    expect(derived.runtime).toBe("declared-lossy");
    expect(derived.lossy.backward).toEqual(["/region"]);
  });
});

describe("a field inside an optional object, translated", () => {
  it("leaves the object optional (Figma)", () => {
    // Figma's `devStatus` is optional and its `type` required. Folding a new
    // type made every node's `devStatus` read as always sent, which the
    // differ reported as it becoming optional again in the new contract.
    const status = {
      type: "object",
      properties: { type: { type: "string", enum: ["NONE", "READY_FOR_DEV"] } },
      required: ["type"],
    };
    const before = contract("3.0.3", {
      ThingCreate: thing({ name: { type: "string" } }, []),
      Thing: thing({ devStatus: status }, []),
    });
    const fold = {
      op: "convert",
      path: "/devStatus/type",
      codec: {
        kind: "enumMap",
        pairs: [
          ["NONE", "NONE"],
          ["READY_FOR_DEV", "READY_FOR_DEV"],
        ],
        fold: [["COMPLETED", "READY_FOR_DEV"]],
      },
    };
    const thingAfter = (predicted(before, [change("Thing", fold)]) as JsonObject)[
      "Thing"
    ] as JsonObject;
    expect(thingAfter["required"]).toBeUndefined();
    expect(
      ((thingAfter["properties"] as JsonObject)["devStatus"] as JsonObject)["required"],
    ).toEqual(["type"]);
  });
});

describe("a request field that is now required", () => {
  const before = contract("3.0.3", {
    ThingCreate: thing({ name: { type: "string" }, tier: { type: "string" } }, ["name"]),
    Thing: thing({ id: { type: "string" } }, ["id"]),
  });
  const op = {
    op: "default",
    path: "/tier",
    value: "basic",
    when: "absent",
    toward: "new",
  };

  it("is predicted required", () => {
    expect(
      (predicted(before, [change("ThingCreate", op)]) as JsonObject)["ThingCreate"],
    ).toEqual(
      thing({ name: { type: "string" }, tier: { type: "string" } }, ["name", "tier"]),
    );
  });

  it("is given the default for old callers who left it out, and nothing on the way back", () => {
    const { forward, backward } = instrsFor(change("ThingCreate", op));
    expect(forward).toEqual([
      {
        k: "set",
        path: "/tier",
        value: "basic",
        ifAbsent: true,
        c: "chg_nullability",
      },
    ]);
    expect(backward).toEqual([]);
    expect(derive(change("ThingCreate", op)).lossy.forward).toEqual(["/tier"]);
  });
});

describe("a request field that may no longer be null", () => {
  it("drops a null an old caller sent, predicted not nullable in either version", () => {
    for (const [version, before, after] of [
      ["3.0.3", { type: "string", nullable: true }, { type: "string" }],
      ["3.1.0", { type: ["string", "null"] }, { type: "string" }],
      [
        "3.1.0",
        { anyOf: [{ $ref: "#/components/schemas/Thing" }, { type: "null" }] },
        { anyOf: [{ $ref: "#/components/schemas/Thing" }] },
      ],
      // Mistral's `tools`: a list or null became a list, written as the list
      // itself, so the prediction is the list and not a union of one.
      [
        "3.1.0",
        {
          title: "Tools",
          anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
        },
        { title: "Tools", type: "array", items: { type: "string" } },
      ],
    ] as const) {
      const document = contract(version, {
        ThingCreate: thing({ note: before as Schema }, []),
        Thing: thing({ id: { type: "string" } }, ["id"]),
      });
      const drop = change("ThingCreate", {
        op: "dropNull",
        path: "/note",
        toward: "new",
      });
      expect((predicted(document, [drop]) as JsonObject)["ThingCreate"], version).toEqual(
        thing({ note: after as Schema }, []),
      );
      expect(instrsFor(drop)).toEqual({
        forward: [{ k: "del", path: "/note", ifNull: true, c: "chg_nullability" }],
        backward: [],
      });
    }
  });

  it("does not touch a schema shared through a reference", () => {
    const document = contract("3.0.3", {
      Note: { type: "string", nullable: true },
      ThingCreate: thing({ note: { $ref: "#/components/schemas/Note" } }, []),
      Thing: thing({ note: { $ref: "#/components/schemas/Note" } }, []),
    });
    const schemas = predicted(document, [
      change("ThingCreate", { op: "dropNull", path: "/note", toward: "new" }),
    ]) as JsonObject;
    expect(schemas["Note"]).toEqual({ type: "string", nullable: true });
    expect(schemas["Thing"]).toEqual(
      thing({ note: { $ref: "#/components/schemas/Note" } }, []),
    );
    expect(schemas["ThingCreate"]).toEqual(thing({ note: { type: "string" } }, []));
  });

  it("is refused where the field is required, since leaving it out is not allowed", () => {
    const document = contract("3.0.3", {
      ThingCreate: thing({ note: { type: "string", nullable: true } }, ["note"]),
      Thing: thing({ id: { type: "string" } }, ["id"]),
    });
    const prediction = predictDocument(document, document, [
      change("ThingCreate", { op: "dropNull", path: "/note", toward: "new" }),
    ]);
    expect(prediction.issues.map((issue) => issue.message).join()).toContain("required");
  });

  it("is refused where nothing says what type the field is", () => {
    const document = contract("3.1.0", {
      ThingCreate: thing({ note: {} }, []),
      Thing: thing({ id: { type: "string" } }, ["id"]),
    });
    const prediction = predictDocument(document, document, [
      change("ThingCreate", { op: "dropNull", path: "/note", toward: "new" }),
    ]);
    expect(prediction.issues.map((issue) => issue.message).join()).toContain(
      "declares no type",
    );
  });
});

describe("an optional response field that may now be null", () => {
  it("is sent to old callers left out rather than null, predicted nullable", () => {
    const document = contract("3.0.3", {
      ThingCreate: thing({ name: { type: "string" } }, []),
      Thing: thing({ id: { type: "string" }, closed_at: { type: "string" } }, ["id"]),
    });
    const drop = change("Thing", { op: "dropNull", path: "/closed_at", toward: "old" });
    expect((predicted(document, [drop]) as JsonObject)["Thing"]).toEqual(
      thing({ id: { type: "string" }, closed_at: { type: "string", nullable: true } }, [
        "id",
      ]),
    );
    expect(instrsFor(drop)).toEqual({
      forward: [],
      backward: [{ k: "del", path: "/closed_at", ifNull: true, c: "chg_nullability" }],
    });
    expect(derive(drop).lossy.backward).toEqual(["/closed_at"]);
  });
});

describe("a request field that now accepts null", () => {
  it("is predicted nullable and compiles to no work, even where it is required", () => {
    const document = contract("3.0.3", {
      ThingCreate: thing({ name: { type: "string" } }, ["name"]),
      Thing: thing({ id: { type: "string" } }, ["id"]),
    });
    const record = change("ThingCreate", {
      op: "dropNull",
      path: "/name",
      toward: "old",
    });
    expect((predicted(document, [record]) as JsonObject)["ThingCreate"]).toEqual(
      thing({ name: { type: "string", nullable: true } }, ["name"]),
    );
  });
});

describe("a field added to a schema whose operations moved with no declared route", () => {
  it("takes its shape from the new contract's schema of the same name", () => {
    const before = contract("3.0.3", {
      ThingCreate: thing({ name: { type: "string" } }, []),
      Thing: thing({ id: { type: "string" } }, ["id"]),
    });
    const after = {
      ...before,
      paths: { "/v2/things": (before["paths"] as JsonObject)["/things"] },
      components: {
        schemas: {
          ThingCreate: thing({ name: { type: "string" } }, []),
          Thing: thing({ id: { type: "string" }, spec: { type: "string" } }, [
            "id",
            "spec",
          ]),
        },
      },
    } as unknown as OpenApiDocument;
    const add = change("Thing", { op: "add", path: "/spec", value: null });
    const prediction = predictDocument(before, after, [add]);
    expect(prediction.issues).toEqual([]);
    expect(
      ((prediction.document["components"] as JsonObject)["schemas"] as JsonObject)[
        "Thing"
      ],
    ).toEqual(
      thing({ id: { type: "string" }, spec: { type: "string" } }, ["id", "spec"]),
    );
  });
});

describe("a field added with a shape that refers to schemas only the new contract has", () => {
  it("brings those schemas into the prediction, and what they refer to", () => {
    const before = contract("3.0.3", {
      ThingCreate: thing({ name: { type: "string" } }, []),
      Thing: thing({ id: { type: "string" } }, ["id"]),
    });
    const after = contract("3.0.3", {
      ThingCreate: thing({ name: { type: "string" } }, []),
      Thing: thing(
        { id: { type: "string" }, credit: { $ref: "#/components/schemas/Credit" } },
        ["id"],
      ),
      Credit: thing({ student: { $ref: "#/components/schemas/Student" } }, []),
      Student: thing({ school: { type: "string" } }, []),
    });
    const prediction = predictDocument(before, after, [
      change("Thing", { op: "add", path: "/credit", value: null }),
    ]);
    expect(prediction.issues).toEqual([]);
    const schemas = (prediction.document["components"] as JsonObject)[
      "schemas"
    ] as JsonObject;
    // The field's own reference is resolved into it, so Credit arrives
    // inline; what Credit refers to has to be defined for that to mean
    // anything.
    expect(Object.keys(schemas).sort()).toEqual(["Student", "Thing", "ThingCreate"]);
  });
});

describe("a nullable enum that lists null, renamed a value", () => {
  it("is mapped and predicted with null still listed, as the runtime passes it through", () => {
    // Plaid's `StudentRepaymentPlan.type`: `interest-only` became `interest only`.
    const plan = (values: (string | null)[]) =>
      thing(
        {
          id: { type: "string" },
          type: { type: "string", nullable: true, enum: values },
        },
        ["id"],
      );
    const document = contract("3.0.3", {
      ThingCreate: thing({ name: { type: "string" } }, []),
      Thing: plan(["standard", "interest-only", null]),
    });
    const rename = change("Thing", {
      op: "convert",
      path: "/type",
      codec: {
        kind: "enumMap",
        pairs: [
          ["standard", "standard"],
          ["interest-only", "interest only"],
        ],
      },
    });
    expect((predicted(document, [rename]) as JsonObject)["Thing"]).toEqual(
      plan(["standard", "interest only", null]),
    );
  });
});
