/**
 * The contract mock answers like the API its contract describes: it refuses a
 * request the contract does not allow, and every response it makes is one the
 * contract allows, judged by the independent oracle.
 */
import { describe, expect, it } from "vitest";
import { createContractMock } from "./mock.mts";

const document = {
  openapi: "3.0.3",
  info: { title: "shop", version: "2" },
  paths: {
    "/orders": {
      post: {
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/NewOrder" } },
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
    },
    "/orders/count": {
      get: {
        responses: {
          "200": {
            description: "how many",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["count"],
                  properties: { count: { type: "integer", minimum: 0 } },
                },
              },
            },
          },
        },
      },
    },
    "/orders/{id}": {
      get: {
        responses: { "200": { $ref: "#/components/responses/OneOrder" } },
      },
      delete: { responses: { "204": { description: "gone" } } },
    },
  },
  components: {
    responses: {
      OneOrder: {
        description: "an order",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/Order" } },
        },
      },
    },
    schemas: {
      NewOrder: {
        type: "object",
        required: ["amount"],
        properties: { amount: { type: "integer", minimum: 1 } },
      },
      Order: {
        allOf: [
          { $ref: "#/components/schemas/NewOrder" },
          {
            type: "object",
            required: ["id", "status"],
            properties: {
              id: { type: "string", minLength: 4 },
              status: { type: "string", enum: ["open", "paid"] },
              note: { type: "string", nullable: true },
            },
          },
        ],
      },
    },
  },
};

const post = (body: unknown) =>
  new Request("http://mock/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("the contract mock", () => {
  it("accepts a conforming request and answers with a conforming response", async () => {
    const mock = createContractMock(document as never);
    const response = await mock.fetch(post({ amount: 5 }));
    expect(response.status).toBe(201);
    expect(mock.log).toEqual([
      { method: "post", path: "/orders", request: [], status: 201, responseValid: true },
    ]);
  });

  it("refuses a request the contract does not allow, and says where", async () => {
    const mock = createContractMock(document as never);
    const response = await mock.fetch(post({ amount: 0 }));
    expect(response.status).toBe(400);
    expect(mock.log[0]?.request?.map((violation) => violation.pointer)).toEqual([
      "/amount",
    ]);
  });

  it("generates only valid responses, through references and allOf", async () => {
    const mock = createContractMock(document as never, { seed: 7 });
    for (let index = 0; index < 50; index += 1) {
      await mock.fetch(new Request(`http://mock/orders/ord_${index}`));
    }
    expect(mock.log.every((entry) => entry.responseValid === true)).toBe(true);
  });

  it("routes a literal path before a templated one", async () => {
    const mock = createContractMock(document as never);
    await mock.fetch(new Request("http://mock/orders/count"));
    expect(mock.log[0]?.path).toBe("/orders/count");
    expect(mock.log[0]?.responseValid).toBe(true);
  });

  it("answers a bodiless success with no body, and an unknown route with 404", async () => {
    const mock = createContractMock(document as never);
    expect(
      (await mock.fetch(new Request("http://mock/orders/1", { method: "DELETE" })))
        .status,
    ).toBe(204);
    expect((await mock.fetch(new Request("http://mock/refunds"))).status).toBe(404);
  });

  it("counts a response its own contract cannot be satisfied by, rather than passing it", async () => {
    // A closed schema used as an allOf member forbids its siblings' fields
    // under JSON Schema, a pattern real specifications contain. No response
    // can satisfy it, so the sample proves nothing and is recorded as such.
    const closed = structuredClone(document);
    Object.assign(closed.components.schemas.NewOrder, { additionalProperties: false });
    const mock = createContractMock(closed as never);
    await mock.fetch(new Request("http://mock/orders/abcd"));
    expect(mock.log[0]?.responseValid).toBe(false);
  });

  it("is deterministic for a seed", async () => {
    const body = async () =>
      (
        await createContractMock(document as never, { seed: 3 }).fetch(
          new Request("http://mock/orders/abc"),
        )
      ).text();
    expect(await body()).toBe(await body());
  });
});
