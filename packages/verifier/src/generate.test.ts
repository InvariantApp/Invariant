/**
 * Scenarios made from a document, for a provider who wrote none: what a
 * create returns carried into the reads after it, values taken from what the
 * document says, and an operation left out, with why, rather than sent with
 * something made up that proves nothing.
 */
import type { OpenApiDocument } from "@invariant/contract";
import { describe, expect, it } from "vitest";
import { exampleOf, scenariosFromDocument } from "./generate.ts";
import { parseScenario, scenarioYaml } from "./scenarios.ts";

const json = (schema: unknown) => ({ content: { "application/json": { schema } } });

const DOCUMENT = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {
    "/v1/orders": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrderCreate" },
              example: { sku: "sku_1", quantity: 2 },
            },
          },
        },
        responses: {
          "201": { description: "made", ...json({ $ref: "#/components/schemas/Order" }) },
        },
      },
      get: {
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 10 } },
        ],
        responses: { "200": { description: "list" } },
      },
    },
    "/v1/orders/{order}": {
      parameters: [
        { name: "order", in: "path", required: true, schema: { type: "string" } },
      ],
      get: {
        responses: {
          "200": { description: "one", ...json({ $ref: "#/components/schemas/Order" }) },
        },
      },
      delete: { responses: { "204": { description: "gone" } } },
    },
    "/v1/reports": {
      get: {
        parameters: [
          {
            name: "since",
            in: "query",
            required: true,
            schema: { type: "string", format: "date" },
          },
        ],
        responses: { "200": { description: "report" } },
      },
    },
    "/v1/codes/{code}": {
      get: {
        parameters: [
          {
            name: "code",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[A-Z]{3}$" },
          },
        ],
        responses: { "200": { description: "code" } },
      },
    },
    "/v1/uploads": {
      post: {
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object" } } },
        },
        responses: { "201": { description: "stored" } },
      },
    },
  },
  components: {
    schemas: {
      OrderCreate: {
        type: "object",
        required: ["sku", "quantity"],
        properties: {
          sku: { type: "string" },
          quantity: { type: "integer", minimum: 1 },
        },
      },
      Order: {
        type: "object",
        required: ["id", "status"],
        properties: {
          id: { type: "string", readOnly: true },
          status: { type: "string", enum: ["open", "paid"] },
        },
      },
    },
  },
} as unknown as OpenApiDocument;

describe("scenarios from a document", () => {
  const { scenarios, skipped } = scenariosFromDocument(DOCUMENT, "2026-01-01", {
    headers: { authorization: "Bearer sk_test" },
  });

  it("makes a thing and uses it, carrying its id into every later step", () => {
    const chain = scenarios.find((scenario) =>
      scenario.name.startsWith("make /v1/orders"),
    );
    expect(chain?.contract).toBe("2026-01-01");
    expect(chain?.steps.map((step) => [step.id, step.method, step.path])).toEqual([
      ["create", "POST", "/v1/orders"],
      ["read", "GET", `/v1/orders/\${create.id}`],
      ["list", "GET", "/v1/orders"],
      ["delete", "DELETE", `/v1/orders/\${create.id}`],
    ]);
    // The document's own example, not one made from the types.
    expect(chain?.steps[0]?.body).toEqual({ sku: "sku_1", quantity: 2 });
    expect(chain?.steps[0]?.capture).toEqual({ id: "/id" });
    expect(chain?.steps[0]?.headers).toEqual({
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    });
  });

  it("asks what can be asked on its own, filling what is required", () => {
    const report = scenarios.find((scenario) =>
      scenario.name.startsWith("GET /v1/reports"),
    );
    expect(report?.steps[0]?.path).toBe("/v1/reports?since=2026-01-01");
  });

  it("leaves out what it cannot fill in, and says why", () => {
    expect(skipped).toEqual([
      "GET /v1/codes/{code}: its path parameter code has no example and no type to make one from",
      "POST /v1/uploads: its body is not JSON",
    ]);
  });

  it("makes values from the document before the types, and none from a pattern", () => {
    expect(exampleOf(DOCUMENT, { $ref: "#/components/schemas/Order" })).toEqual({
      status: "open",
    });
    expect(exampleOf(DOCUMENT, { type: "string", pattern: "^x$" })).toBeUndefined();
    expect(
      exampleOf(DOCUMENT, { type: "array", minItems: 2, items: { type: "boolean" } }),
    ).toEqual([true, true]);
  });

  it("writes each as a file that reads back as the same scenario", () => {
    for (const scenario of scenarios) {
      const text = scenarioYaml(scenario, "Made from the document.\nEdit freely.");
      expect(text.startsWith("# Made from the document.\n# Edit freely.\n")).toBe(true);
      expect(parseScenario(text, "generated.yaml")).toEqual(scenario);
    }
  });
});
