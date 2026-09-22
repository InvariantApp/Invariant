/**
 * Form-encoded request bodies, from Changes to the bytes a provider receives.
 *
 * Stripe declares its request bodies only as forms, with nested fields in
 * bracketed keys. A Change describes fields, so the same Change has to serve
 * a form exactly as it serves JSON, and a value typed from the schema, so a
 * scale sees `49.99` as a number.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { type Change, parseChange } from "@invariant-app/ir";
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { traceBack } from "./form.ts";
import { predictDocument } from "./predict.ts";

function stripe(properties: Record<string, unknown>): OpenApiDocument {
  return {
    openapi: "3.0.3",
    info: { title: "payments", version: "1" },
    paths: {
      "/v1/charges": {
        post: {
          operationId: "PostCharges",
          requestBody: {
            content: {
              "application/x-www-form-urlencoded": {
                schema: { $ref: "#/components/schemas/ChargeCreate" },
                encoding: { metadata: { style: "deepObject", explode: true } },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: { schemas: { ChargeCreate: { type: "object", properties } } },
  } as unknown as OpenApiDocument;
}

const change = (id: string, ops: unknown[]): Change =>
  parseChange({
    irVersion: 1,
    id,
    summary: id,
    scopes: [{ schema: "#/components/schemas/ChargeCreate" }],
    ops,
  });

const metadata = { type: "object", additionalProperties: { type: "string" } };

async function send(program: unknown, label: string, body: string): Promise<string> {
  const runtime = createRuntime({ program, identity: [{ kind: "default", label }] });
  const site = runtime.siteFor(label, "post", "/v1/charges");
  if (!site) throw new Error("no site");
  const adapted = await runtime.adaptRequest(
    site,
    new Request("https://api.example.com/v1/charges", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    { path: "/v1/charges", search: "", headers: new Headers() },
    { contract: label, operation: "PostCharges" },
  );
  return String(adapted.body);
}

describe("a form-encoded request body", () => {
  it("is served by the same Change a JSON body would be", async () => {
    const v1 = stripe({
      amount: { type: "number" },
      metadata,
      currency: { type: "string" },
    });
    const v2 = stripe({
      amount: { type: "integer" },
      metadata,
      currency: { type: "string" },
    });
    const { program, issues } = chainProgram("payments", "v2", "sha256:2", [
      {
        label: "v2",
        parent: "v1",
        from: v1,
        to: v2,
        changes: [
          change("chg_minor_units", [
            {
              op: "convert",
              path: "/amount",
              codec: { kind: "scale10", exponent: 2, onInexact: "reject" },
            },
          ]),
        ],
      },
    ]);
    expect(issues).toEqual([]);
    expect(program.contracts["v1"]?.sites["post /v1/charges"]?.form).toEqual({
      fields: { metadata: { style: "deepObject", explode: true } },
      types: { "/amount": "number" },
    });
    expect(
      await send(program, "v1", "currency=usd&amount=49.99&metadata[order]=6735"),
    ).toBe("currency=usd&metadata[order]=6735&amount=4999");
  });

  it("types a value where the caller wrote it, when an earlier step moved it", async () => {
    const v1 = stripe({ amount_decimal: { type: "number" } });
    const v2 = stripe({ amount: { type: "number" } });
    const v3 = stripe({ amount: { type: "integer" } });
    const { program, issues } = chainProgram("payments", "v3", "sha256:3", [
      {
        label: "v2",
        parent: "v1",
        from: v1,
        to: v2,
        changes: [
          change("chg_amount", [{ op: "move", from: "/amount_decimal", to: "/amount" }]),
        ],
      },
      {
        label: "v3",
        parent: "v2",
        from: v2,
        to: v3,
        changes: [
          change("chg_minor_units", [
            {
              op: "convert",
              path: "/amount",
              codec: { kind: "scale10", exponent: 2, onInexact: "reject" },
            },
          ]),
        ],
      },
    ]);
    expect(issues).toEqual([]);
    expect(program.contracts["v1"]?.sites["post /v1/charges"]?.form?.types).toEqual({
      "/amount_decimal": "number",
    });
    expect(await send(program, "v1", "amount_decimal=1.5")).toBe("amount=150");
  });

  it("traces a pointer back through the moves before it", () => {
    expect(
      traceBack("/a/b/c", [
        { k: "move", from: "/y/b", to: "/x/b", c: "c1" },
        { k: "move", from: "/x", to: "/a", c: "c2" },
      ]),
    ).toBe("/y/b/c");
    // A move that ran after the value was already moved away plays no part.
    expect(
      traceBack("/a/b/c", [
        { k: "move", from: "/x", to: "/a", c: "c1" },
        { k: "move", from: "/y/b", to: "/x/b", c: "c2" },
      ]),
    ).toBe("/x/b/c");
  });
});

describe("an inline request body, as Twilio declares its forms", () => {
  const twilio = (properties: Record<string, unknown>): OpenApiDocument =>
    ({
      openapi: "3.0.1",
      info: { title: "api", version: "1" },
      paths: {
        "/Calls/{CallSid}/Transcriptions.json": {
          post: {
            operationId: "CreateRealtimeTranscription",
            parameters: [
              { name: "CallSid", in: "path", required: true, schema: { type: "string" } },
            ],
            requestBody: {
              content: {
                "application/x-www-form-urlencoded": {
                  schema: { type: "object", properties },
                },
              },
            },
            responses: { "201": { description: "made" } },
          },
        },
      },
    }) as unknown as OpenApiDocument;

  it("is changed by an operation-scoped Change, predicted and served", async () => {
    const before = twilio({
      Name: { type: "string" },
      ConfigurationId: { type: "string" },
    });
    const after = twilio({ Name: { type: "string" } });
    const removal = parseChange({
      irVersion: 1,
      id: "chg_configuration_id",
      summary: "ConfigurationId was removed.",
      scopes: [{ operation: "CreateRealtimeTranscription", location: "body" }],
      ops: [{ op: "remove", path: "/ConfigurationId", restore: null }],
    });
    const prediction = predictDocument(before, after, [removal]);
    expect(prediction.issues).toEqual([]);
    expect(JSON.stringify(prediction.document)).toBe(JSON.stringify(after));

    const { program, issues } = chainProgram("api", "v2", "sha256:2", [
      { label: "v2", parent: "v1", from: before, to: after, changes: [removal] },
    ]);
    expect(issues).toEqual([]);
    const site =
      program.contracts["v1"]?.sites["post /Calls/{CallSid}/Transcriptions.json"];
    expect(site?.request).toEqual([
      { k: "del", path: "/ConfigurationId", c: "chg_configuration_id" },
    ]);
    expect(site?.envelope).toBeUndefined();

    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "v1" }],
    });
    const decoded = runtime.siteFor("v1", "post", "/Calls/CA1/Transcriptions.json");
    expect(decoded).toBeDefined();
    if (!decoded) return;
    const adapted = await runtime.adaptRequest(
      decoded,
      new Request("https://api.example.com/Calls/CA1/Transcriptions.json", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "Name=live&ConfigurationId=cfg_1",
      }),
      { path: "/Calls/CA1/Transcriptions.json", search: "", headers: new Headers() },
      { contract: "v1", operation: "CreateRealtimeTranscription" },
    );
    expect(adapted.body).toBe("Name=live");
  });
});
