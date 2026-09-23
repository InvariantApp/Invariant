/**
 * What old callers send, the whole way a release goes: drafted, compiled,
 * applied to the old contract, every decision answered, and compared with
 * the new one by the pinned differ. Each case is one that stayed unexplained
 * on a real API, although what an old caller sends either still means the
 * same or is served by a Change the IR always had.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesJudge } from "@invariant-app/proposer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analysePair } from "./real.ts";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "request-side-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

type Schema = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema) => ({ content: { "application/json": { schema } } });

/** One operation that takes a request body and parameters and answers with a body. */
function api(options: {
  parameters?: Schema[];
  request: Schema;
  response: Schema;
  schemas: Record<string, Schema>;
}) {
  return {
    openapi: "3.0.3",
    info: { title: "things", version: "1" },
    paths: {
      "/things": {
        post: {
          operationId: "createThing",
          parameters: options.parameters ?? [],
          requestBody: { required: true, ...json(options.request) },
          responses: { "201": { description: "made", ...json(options.response) } },
        },
      },
    },
    components: { schemas: options.schemas },
  };
}

async function analyse(name: string, before: object, after: object) {
  const fromPath = join(directory, `${name}-before.json`);
  const toPath = join(directory, `${name}-after.json`);
  await writeFile(fromPath, JSON.stringify(before));
  await writeFile(toPath, JSON.stringify(after));
  return analysePair(
    { api: `test:${name}`, fromVersion: "1", toVersion: "2", fromPath, toPath },
    { judge: new RulesJudge(), timeoutMs: 120_000 },
  );
}

const thing = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
};

describe("a format stated where the bounds already kept every value (Twilio)", () => {
  const pageSize = (schema: Schema) => ({ name: "PageSize", in: "query", schema });
  const version = (schema: Schema) =>
    api({
      parameters: [pageSize(schema)],
      request: { type: "object", properties: { name: { type: "string" } } },
      response: ref("Thing"),
      schemas: { Thing: thing },
    });

  it("leaves nothing unexplained", async () => {
    const bounded = { type: "integer", minimum: 1, maximum: 1000 };
    const result = await analyse(
      "page-size",
      version(bounded),
      version({ ...bounded, format: "int64" }),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.breakingAfter).toBe(0);
  });

  it("stays unexplained where an old caller may send what the format cannot hold", async () => {
    const result = await analyse(
      "unbounded",
      version({ type: "integer" }),
      version({ type: "integer", format: "int64" }),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingAfterDecided).toBeGreaterThan(0);
  });
});

describe("a place that referred to a named schema and now writes it out (PayPal)", () => {
  it("leaves nothing unexplained once the schema's own decision is answered", async () => {
    // The phone number written out in place lost its country code with the
    // schema it used to refer to, which old callers were always given.
    const phone = (fields: string[]) => ({
      type: "object",
      required: fields,
      properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }])),
    });
    const version = (number: Schema, fields: string[]) =>
      api({
        request: ref("Contact"),
        response: ref("Contact"),
        schemas: {
          Phone: phone(fields),
          Contact: { type: "object", required: ["number"], properties: { number } },
        },
      });
    const result = await analyse(
      "phone",
      version(ref("Phone"), ["country_code", "national_number"]),
      version(phone(["national_number"]), ["national_number"]),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.breakingAfterDecided).toBe(0);
  });
});

describe("a field that may now be missing only where old callers are sent it (Adyen)", () => {
  it("is explained without saying their requests may leave it out", async () => {
    const info = (required: string[]) => ({
      type: "object",
      required,
      properties: { supportUrl: { type: "string" } },
    });
    const version = (response: string) =>
      api({
        request: ref("Setup"),
        response: ref("Method"),
        schemas: {
          Info: info(["supportUrl"]),
          InfoResponse: info([]),
          Setup: { type: "object", properties: { info: ref("Info") } },
          Method: { type: "object", properties: { info: ref(response) } },
        },
      });
    const before = version("Info");
    const { InfoResponse: _unused, ...schemas } = before.components.schemas;
    const result = await analyse(
      "split",
      { ...before, components: { schemas } },
      version("InfoResponse"),
    );
    expect(result.compileIssues).toEqual([]);
    expect(result.breakingBefore).toBeGreaterThan(0);
    expect(result.breakingAfterDecided).toBe(0);
  });
});
