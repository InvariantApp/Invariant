/**
 * What the loader accepts, what it refuses, and whether it says why.
 *
 * Every case here came from running 686 real version pairs. 27 pairs failed to
 * load or to diff, and none of the reasons were the ones the messages gave.
 * Fourteen were Adyen's notification contracts, valid OpenAPI 3.1 describing
 * `webhooks` instead of `paths`. Twelve were Intercom's, which references a
 * schema it never defines. One was Google's, which declares the same endpoint
 * twice under two parameter names. The first was a gap in this loader; the
 * other two are defects in the documents, reported as `exited with 102` and
 * `exited with 104` by a subprocess, which tells a provider nothing.
 */
import { describe, expect, it } from "vitest";
import { findSchemaSites } from "./sites.ts";
import {
  ambiguousPaths,
  ContractError,
  contractOf,
  normalizeDocument,
  type OpenApiDocument,
  operationsOf,
  SWAGGER_CONVERTER,
} from "./spec.ts";

const base = { openapi: "3.1.0", info: { title: "t", version: "1" } };
const doc = (extra: Record<string, unknown>): OpenApiDocument =>
  ({ ...base, ...extra }) as unknown as OpenApiDocument;

const okResponse = { responses: { "200": { description: "ok" } } };

describe("documents that describe webhooks", () => {
  const webhookDoc = doc({
    webhooks: { AUTHORISATION: { post: { operationId: "auth", ...okResponse } } },
  });

  it("loads one that has no paths at all", () => {
    // Adyen publishes 14 of these. Refusing them meant never reporting a
    // breaking change to a notification contract.
    expect(() => normalizeDocument(webhookDoc)).not.toThrow();
  });

  it("finds the webhook as an operation, named the way the differ names it", () => {
    const [operation, ...rest] = operationsOf(webhookDoc);
    expect(rest).toEqual([]);
    expect(operation?.path).toBe("webhook:AUTHORISATION");
    expect(operation?.webhook).toBe(true);
  });

  it("marks an ordinary path as not a webhook", () => {
    const [operation] = operationsOf(doc({ paths: { "/things": { get: okResponse } } }));
    expect(operation?.webhook).toBeUndefined();
  });

  it("builds no adapter site for a webhook, and says why", () => {
    // The provider sends a webhook, so there is no inbound request to rewrite.
    // Reporting the change is right; compiling a transform for it would promise
    // something that could never run.
    const scan = findSchemaSites(
      doc({
        webhooks: {
          AUTHORISATION: {
            post: {
              operationId: "auth",
              requestBody: {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Event" } },
                },
              },
              ...okResponse,
            },
          },
        },
        components: { schemas: { Event: { type: "object" } } },
      }),
      "#/components/schemas/Event",
    );

    expect(scan.sites).toEqual([]);
    expect(scan.unsupported.join(" ")).toMatch(
      /webhook that sends this schema, which this runtime cannot adapt/,
    );
  });

  it("says nothing about a webhook that never sends the schema", () => {
    // Refusing every Change in any document that also has webhooks would block
    // releases for a reason that has nothing to do with them.
    const scan = findSchemaSites(
      doc({
        paths: {
          "/things": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Thing" },
                    },
                  },
                },
              },
            },
          },
        },
        webhooks: {
          PING: {
            post: {
              operationId: "ping",
              requestBody: {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Event" } },
                },
              },
              ...okResponse,
            },
          },
        },
        components: { schemas: { Event: { type: "object" }, Thing: { type: "object" } } },
      }),
      "#/components/schemas/Thing",
    );

    expect(scan.sites).toHaveLength(1);
    expect(scan.unsupported).toEqual([]);
  });
});

describe("documents that point at things they do not define", () => {
  it("names the missing reference and where it is used", () => {
    const broken = doc({
      paths: {
        "/things": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Gone" } },
                },
              },
            },
          },
        },
      },
      components: { schemas: { Present: { type: "object" } } },
    });

    expect(() => normalizeDocument(broken)).toThrow(ContractError);
    expect(() => normalizeDocument(broken)).toThrow(
      /`#\/components\/schemas\/Gone` is referenced but not defined/,
    );
    // Actionable means naming a place, not just a count.
    expect(() => normalizeDocument(broken)).toThrow(/including #/);
  });

  it("still refuses an external reference rather than fetching it", () => {
    const external = doc({
      paths: {
        "/things": { get: { ...okResponse, parameters: [{ $ref: "https://x/y" }] } },
      },
    });
    expect(() => normalizeDocument(external)).toThrow(/External \$ref is not allowed/);
  });
});

describe("documents whose endpoints collide", () => {
  /**
   * Reported, not refused, and that is a correction. Refusing them looked
   * right, but GitHub ships
   * `/orgs/{org}/attestations/{attestation_id}` beside
   * `/orgs/{org}/attestations/{subject_digest}` on purpose, and rejecting that
   * traded one unusable Google document for seven GitHub ones that had been
   * comparing perfectly well.
   */
  it("finds templates that are the same endpoint without the parameter names", () => {
    const clashes = ambiguousPaths(
      doc({
        paths: {
          "/v1/{organization}/dataExchanges": { get: okResponse },
          "/v1/{parent}/dataExchanges": { get: okResponse },
          "/v1/{id}/listings": { get: okResponse },
        },
      }),
    );

    expect(clashes).toHaveLength(1);
    expect(clashes[0]?.sort()).toEqual([
      "/v1/{organization}/dataExchanges",
      "/v1/{parent}/dataExchanges",
    ]);
  });

  it("loads such a document anyway", () => {
    expect(() =>
      normalizeDocument(
        doc({
          paths: {
            "/orgs/{org}/attestations/{attestation_id}": { get: okResponse },
            "/orgs/{org}/attestations/{subject_digest}": { get: okResponse },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("says nothing about templates that differ in shape", () => {
    expect(
      ambiguousPaths(
        doc({
          paths: {
            "/v1/{id}/dataExchanges": { get: okResponse },
            "/v1/{id}/listings": { get: okResponse },
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe("references that do not constrain the wire", () => {
  it("ignores a dangling reference inside examples", () => {
    // Adyen references example components it never defines, 55 times in one
    // document. An illustration nobody can resolve is not a reason to refuse
    // to compare the contract, and the digest already excludes examples.
    expect(() =>
      normalizeDocument(
        doc({
          paths: {
            "/things": {
              post: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: { type: "object" },
                      examples: { generic: { $ref: "#/components/examples/generic" } },
                    },
                  },
                },
                ...okResponse,
              },
            },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("still refuses one in a schema, where it does constrain the wire", () => {
    expect(() =>
      normalizeDocument(
        doc({
          paths: {
            "/things": {
              post: {
                requestBody: {
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Gone" } },
                  },
                },
                ...okResponse,
              },
            },
          },
        }),
      ),
    ).toThrow(/is referenced but not defined/);
  });
});

describe("documents with nothing to serve", () => {
  it("says so when there are neither paths nor webhooks", () => {
    expect(() => normalizeDocument(doc({}))).toThrow(/no paths or webhooks/);
  });

  it("refuses anything that is neither OpenAPI 3 nor Swagger 2.0", () => {
    expect(() =>
      normalizeDocument({ swagger: "1.2", paths: {} } as unknown as OpenApiDocument),
    ).toThrow(/Only OpenAPI 3.x/);
  });
});

/**
 * Kubernetes, Slack, Square, Docker Engine, Gitea and GitLab publish Swagger
 * 2.0, and refusing it left all of them out.
 */
describe("a Swagger 2.0 document", () => {
  const swagger = {
    swagger: "2.0",
    info: { title: "pets", version: "1" },
    basePath: "/v1",
    consumes: ["application/json"],
    produces: ["application/json"],
    paths: {
      "/pets": {
        post: {
          operationId: "createPet",
          parameters: [
            {
              in: "body",
              name: "pet",
              required: true,
              schema: { $ref: "#/definitions/Pet" },
            },
            { in: "query", name: "dry_run", type: "boolean" },
          ],
          responses: {
            "201": { description: "made", schema: { $ref: "#/definitions/Pet" } },
          },
        },
      },
    },
    definitions: {
      Pet: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, tag: { type: "string" } },
      },
    },
  } as unknown as OpenApiDocument;

  it("is read as the OpenAPI 3.0 it describes", () => {
    const contract = contractOf("1", swagger);
    // biome-ignore lint/suspicious/noExplicitAny: a converted document, read loosely
    const document = contract.document as Record<string, any>;
    expect(document["openapi"]).toMatch(/^3\.0/);
    expect(document["components"].schemas.Pet.required).toEqual(["name"]);
    const post = document["paths"]["/pets"].post;
    expect(post.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Pet",
    });
    expect(post.responses["201"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Pet",
    });
    expect(post.parameters).toEqual([
      expect.objectContaining({
        in: "query",
        name: "dry_run",
        schema: { type: "boolean" },
      }),
    ]);
  });

  it("says it was converted, and by what, and leaves the original alone", () => {
    const before = JSON.stringify(swagger);
    const contract = contractOf("1", swagger);
    expect(contract.convertedFrom).toEqual({
      format: "swagger-2.0",
      by: SWAGGER_CONVERTER,
    });
    expect(JSON.stringify(swagger)).toBe(before);
    expect(contractOf("1", swagger).digest).toBe(contract.digest);
  });
});
