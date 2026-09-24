/**
 * The last places left on pairs that were otherwise explained, the whole way
 * a release goes: drafted, compiled, applied to the old contract, every
 * decision answered, and compared with the new one by the pinned differ.
 * Each case is the one place that kept a real pair from closing, and each
 * is either a value a provider decides, as a body field's already was, or a
 * change that provably says the same, or a loss the Change declares.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesJudge } from "@invariant-app/proposer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analysePair } from "./real.ts";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "whole-pairs-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

type Schema = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema) => ({ content: { "application/json": { schema } } });
const object = (properties: Record<string, Schema>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});

/** One operation, with what it takes and what it answers. */
function api(options: {
  openapi?: string;
  method?: string;
  parameters?: Schema[];
  request?: Schema;
  response?: Schema;
  schemas?: Record<string, Schema>;
}) {
  return {
    openapi: options.openapi ?? "3.0.3",
    info: { title: "things", version: "1" },
    paths: {
      "/things": {
        [options.method ?? "post"]: {
          operationId: "thing",
          parameters: options.parameters ?? [],
          ...(options.request ? { requestBody: json(options.request) } : {}),
          responses: {
            "200": {
              description: "ok",
              ...(options.response ? json(options.response) : {}),
            },
          },
        },
      },
    },
    components: { schemas: options.schemas ?? {} },
  };
}

async function closes(name: string, before: object, after: object) {
  const fromPath = join(directory, `${name}-before.json`);
  const toPath = join(directory, `${name}-after.json`);
  await writeFile(fromPath, JSON.stringify(before));
  await writeFile(toPath, JSON.stringify(after));
  const result = await analysePair(
    { api: `test:${name}`, fromVersion: "1", toVersion: "2", fromPath, toPath },
    { judge: new RulesJudge(), timeoutMs: 120_000 },
  );
  expect(result.decidedError).toBeUndefined();
  expect(result.compileIssues).toEqual([]);
  expect(result.breakingBefore).toBeGreaterThan(0);
  return result;
}

describe("a parameter, asked about as a body field is", () => {
  const query = (name: string, schema: Schema, required = false) => ({
    name,
    in: "query",
    required,
    schema,
  });

  it("sends a value that went as the one the provider chooses (Supabase, Sentry)", async () => {
    const sized = (values: string[]) =>
      api({
        method: "get",
        parameters: [query("size", { type: "string", enum: values })],
      });
    const result = await closes(
      "size",
      sized(["pico", "nano", "micro"]),
      sized(["nano", "micro"]),
    );
    expect(result.breakingAfterDecided).toBe(0);
  });

  it("sends the provider's value where one became required (Asana)", async () => {
    const workspace = (required: boolean) =>
      api({
        method: "get",
        parameters: [query("workspace", { type: "string" }, required)],
      });
    const result = await closes("workspace", workspace(false), workspace(true));
    expect(result.breakingAfterDecided).toBe(0);
  });
});

it("sends a request value that went as one the provider chooses, beside ones that arrived (Plaid)", async () => {
  const token = (values: string[]) =>
    api({
      request: ref("TokenCreate"),
      schemas: {
        TokenCreate: object({ processor: { type: "string", enum: values } }, [
          "processor",
        ]),
      },
    });
  const result = await closes(
    "processor",
    token(["dwolla", "paynote"]),
    token(["dwolla", "seamlessach", "kikoff_enterprise"]),
  );
  expect(result.breakingAfterDecided).toBe(0);
});

describe("a list body written in place (Sentry's dashboards)", () => {
  const dashboards = (fields: Record<string, Schema>, required: string[]) =>
    api({
      method: "get",
      response: {
        type: "array",
        items: object({ id: { type: "string" }, ...fields }, ["id", ...required]),
      },
    });
  const hidden = { isHidden: { type: "boolean" } };

  it("takes a field each item came to carry out of what old callers are sent", async () => {
    const result = await closes(
      "added",
      dashboards({}, []),
      dashboards(hidden, ["isHidden"]),
    );
    expect(result.breakingAfter).toBe(0);
  });

  it("gives old callers the provider's value for a field each item stopped carrying", async () => {
    const result = await closes(
      "removed",
      dashboards(hidden, ["isHidden"]),
      dashboards({}, []),
    );
    expect(result.breakingAfterDecided).toBe(0);
  });
});

describe("a value that says the same another way", () => {
  const every = ["number", "integer", "string", "boolean", "null", "array", "object"];

  it("restates a patch value written as every type, as nothing, and as a list of every type (PayPal)", async () => {
    const patch = (value: Schema) =>
      object({ op: { type: "string", enum: ["add", "replace"] }, value }, ["op"]);
    const version = (value: Schema) =>
      api({
        method: "patch",
        openapi: "3.1.0",
        request: { type: "array", items: patch(value) },
      });
    const choice = { anyOf: every.map((type) => ({ type })) };
    const first = await closes("patch-choice", version(choice), version({}));
    expect(first.breakingAfter).toBe(0);
    const second = await closes("patch-types", version({}), version({ type: every }));
    expect(second.breakingAfter).toBe(0);
  });

  it("restates a comment that came to say it is a password, which only a form reads (CloudFront)", async () => {
    const config = (comment: Schema) =>
      api({ request: ref("Config"), schemas: { Config: object({ Comment: comment }) } });
    const result = await closes(
      "password",
      config({ type: "string" }),
      config({ type: "string", format: "password" }),
    );
    expect(result.breakingAfter).toBe(0);
  });

  it("restates null said with 3.0's flag in a 3.1 document, then with a list of types (Resend)", async () => {
    const event = (schema: Schema) =>
      api({
        openapi: "3.1.0",
        request: ref("CreateEvent"),
        schemas: { CreateEvent: object({ name: { type: "string" }, schema }) },
      });
    const result = await closes(
      "null-spelling",
      event({ type: "object", nullable: true }),
      event({ type: ["object", "null"] }),
    );
    expect(result.breakingAfter).toBe(0);
  });
});

describe("a loss the Change declares", () => {
  it("sends a file name that may now be null as it left out, said as the new contract says it (Resend)", async () => {
    const attachment = (name: Schema) =>
      api({
        openapi: "3.1.0",
        method: "get",
        response: ref("Attachment"),
        schemas: {
          Attachment: object({ id: { type: "string" }, filename: name }, ["id"]),
        },
      });
    const result = await closes(
      "flag-in-3.1",
      attachment({ type: "string" }),
      attachment({ type: "string", nullable: true }),
    );
    expect(result.breakingAfter).toBe(0);
  });

  it("leaves a node whose image failed to render out of the map (Figma)", async () => {
    const images = (value: Schema) =>
      api({
        openapi: "3.1.0",
        method: "get",
        response: object({ images: { type: "object", additionalProperties: value } }),
      });
    const result = await closes(
      "map-values",
      images({ type: "string", format: "uri" }),
      images({ type: ["string", "null"], format: "uri" }),
    );
    expect(result.breakingAfter).toBe(0);
  });

  it("passes a response value on under a format old callers were not promised (Twilio)", async () => {
    const phone = (format: string) =>
      api({
        method: "get",
        response: ref("Phone"),
        schemas: { Phone: object({ capabilities: { type: "object", format } }) },
      });
    const result = await closes(
      "format",
      phone("string-map"),
      phone("phone-number-capabilities"),
    );
    expect(result.breakingAfter).toBe(0);
  });

  it("leaves a kind of error written out in place, that old callers never saw, out of the list (Supabase)", async () => {
    const kind = (type: string, field: string) =>
      object({ type: { type: "string", enum: [type] }, [field]: { type: "string" } }, [
        "type",
        field,
      ]);
    const eligibility = (kinds: Schema[]) =>
      api({
        method: "get",
        response: ref("Eligibility"),
        schemas: {
          Eligibility: object({
            validation_errors: { type: "array", items: { oneOf: kinds } },
          }),
        },
      });
    const extension = kind("unsupported_extension", "extension_name");
    const result = await closes(
      "inline-variant",
      eligibility([extension]),
      eligibility([extension, kind("indexes_referencing_ll_to_earth", "index_name")]),
    );
    expect(result.breakingAfter).toBe(0);
  });
});
