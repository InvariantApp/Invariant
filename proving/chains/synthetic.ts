/**
 * A long chain of releases over a large API, generated, for measuring what a
 * program costs as history grows (launch gate L18).
 *
 * Stripe-sized by default: several hundred operations over a few hundred
 * schemas, with one schema, `Resource`, reached from every operation's
 * response and every tenth one's request, as Stripe's shared objects are.
 * Each step renames one field of `Resource` and converts another's unit, so
 * every step reaches every site, which is the case that grows fastest.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { type Change, parseChange } from "@invariant-app/ir";

export interface ChainShape {
  operations: number;
  schemas: number;
  steps: number;
}

export const STRIPE_SIZED: ChainShape = { operations: 600, schemas: 400, steps: 50 };

/** The name the field renamed at step `index` has before and after it. */
const field = (step: number) => `field_${step}`;

/** The document at `version`, where fields 0 to version-1 have been renamed. */
export function documentAt(shape: ChainShape, version: number): OpenApiDocument {
  const properties: Record<string, unknown> = { id: { type: "string" } };
  for (let step = 0; step < shape.steps; step += 1) {
    const renamed = step < version;
    properties[renamed ? `${field(step)}_v2` : field(step)] = renamed
      ? { type: "integer" }
      : { type: "number", multipleOf: 0.01 };
  }
  const schemas: Record<string, unknown> = {
    Resource: { type: "object", required: ["id"], properties },
  };
  for (let index = 0; index < shape.schemas; index += 1) {
    schemas[`Object${index}`] = {
      type: "object",
      properties: {
        name: { type: "string" },
        resource: { $ref: "#/components/schemas/Resource" },
        count: { type: "integer" },
      },
    };
  }
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < shape.operations; index += 1) {
    const schema = { $ref: `#/components/schemas/Object${index % shape.schemas}` };
    const body = { content: { "application/json": { schema } } };
    paths[`/v1/objects${index}/{id}`] = {
      [index % 10 === 0 ? "post" : "get"]: {
        operationId: `operation${index}`,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        ...(index % 10 === 0 ? { requestBody: body } : {}),
        responses: { "200": { description: "ok", ...body } },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: "synthetic", version: String(version) },
    paths,
    components: { schemas },
  } as unknown as OpenApiDocument;
}

/** The Change that takes version `step` to version `step + 1`. */
export function changeAt(step: number): Change {
  return parseChange({
    irVersion: 1,
    id: `chg_step_${step}`,
    summary: `Field ${step} is in minor units.`,
    scopes: [{ schema: "#/components/schemas/Resource" }],
    ops: [
      { op: "move", from: `/${field(step)}`, to: `/${field(step)}_v2` },
      {
        op: "convert",
        path: `/${field(step)}_v2`,
        codec: { kind: "scale10", exponent: 2, onInexact: "reject" },
      },
    ],
  });
}
