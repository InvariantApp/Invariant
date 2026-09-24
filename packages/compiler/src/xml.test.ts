/**
 * XML bodies, from Changes to the bytes a caller receives.
 *
 * Amazon's CloudFront declares every body as `text/xml`, names list items in
 * its schema's `xml` object and, release after release, adds values to a
 * distribution's vocabularies. A Change describes fields, so the same Change
 * has to serve XML exactly as it serves JSON, and whatever the runtime could
 * not read back exactly has to stop the release rather than pass untouched.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { type Change, parseChange } from "@invariant-app/ir";
import { createRuntime } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { chainProgram, xmlIssues } from "./chain.ts";
import { predictDocument } from "./predict.ts";

const PROTOCOLS = ["SSLv3", "TLSv1", "TLSv1_2016", "TLSv1.1_2016", "TLSv1.2_2018"];

/** CloudFront's distribution, cut to what these cases need. */
function cloudfront(
  version: string,
  protocols: string[],
  extra: Record<string, unknown> = {},
): OpenApiDocument {
  const xml = (schema: string) => ({
    content: { "text/xml": { schema: { $ref: `#/components/schemas/${schema}` } } },
  });
  return {
    openapi: "3.0.0",
    info: { title: "Amazon CloudFront", version },
    paths: {
      [`/${version}/distribution/{Id}/config`]: {
        get: {
          operationId: "GetDistributionConfig",
          parameters: [
            { name: "Id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Success", ...xml("GetDistributionConfigResult") },
          },
        },
        put: {
          operationId: "UpdateDistribution",
          parameters: [
            { name: "Id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: { required: true, ...xml("UpdateDistributionRequest") },
          responses: {
            "200": { description: "Success", ...xml("GetDistributionConfigResult") },
          },
        },
      },
    },
    components: {
      schemas: {
        GetDistributionConfigResult: {
          type: "object",
          properties: {
            DistributionConfig: { $ref: "#/components/schemas/DistributionConfig" },
          },
        },
        UpdateDistributionRequest: {
          type: "object",
          properties: {
            DistributionConfig: { $ref: "#/components/schemas/DistributionConfig" },
          },
        },
        DistributionConfig: {
          type: "object",
          properties: {
            Comment: { type: "string" },
            Aliases: {
              type: "array",
              xml: { wrapped: true },
              items: { allOf: [{ type: "string" }, { xml: { name: "CNAME" } }] },
            },
            ViewerCertificate: { $ref: "#/components/schemas/ViewerCertificate" },
            ...extra,
          },
        },
        ViewerCertificate: {
          type: "object",
          properties: {
            MinimumProtocolVersion: { type: "string", enum: protocols },
          },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const change = (id: string, schema: string, ops: unknown[]): Change =>
  parseChange({
    irVersion: 1,
    id,
    summary: id,
    scopes: [{ schema: `#/components/schemas/${schema}` }],
    ops,
  });

/**
 * A body as the contract describes it: the result's element, holding the
 * configuration. Amazon's own wire leaves the result's element out, which the
 * document does not say; the runtime reads what the document says.
 */
const DOCUMENT = (version: string, comment = "hi") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Result xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"><DistributionConfig>\n  <Comment>${comment}</Comment>\n  <Aliases><CNAME>a.example.com</CNAME></Aliases>\n  <ViewerCertificate>\n    <MinimumProtocolVersion>${version}</MinimumProtocolVersion>\n  </ViewerCertificate>\n</DistributionConfig></Result>\n`;

describe("an XML body", () => {
  const old = cloudfront("2020-05-31", PROTOCOLS);
  const next = cloudfront("2020-05-31", [...PROTOCOLS, "TLSv1.2_2021"]);
  const fold = change("chg_tls_2021", "ViewerCertificate", [
    {
      op: "convert",
      path: "/MinimumProtocolVersion",
      codec: {
        kind: "enumMap",
        pairs: PROTOCOLS.map((value) => [value, value]),
        fold: [["TLSv1.2_2021", "TLSv1.2_2018"]],
      },
    },
  ]);

  it("is served by the same Change a JSON body would be, and says where a value was folded", async () => {
    const { program, issues } = chainProgram("cloudfront", "new", "sha256:1", [
      { label: "new", parent: "old", from: old, to: next, changes: [fold] },
    ]);
    expect(issues).toEqual([]);
    const site =
      program.contracts["old"]?.sites["get /2020-05-31/distribution/{Id}/config"];
    expect(site?.xml?.response?.["200"]?.read).toEqual({
      type: "object",
      properties: {
        DistributionConfig: {
          type: "object",
          properties: {
            ViewerCertificate: {
              type: "object",
              properties: { MinimumProtocolVersion: { type: "string" } },
            },
          },
        },
      },
    });
    expect(predictDocument(old, next, [fold]).issues).toEqual([]);

    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "old" }],
    });
    const found = runtime.siteFor("old", "get", "/2020-05-31/distribution/E1/config");
    const response = await runtime.adaptResponse(
      found,
      new Response(DOCUMENT("TLSv1.2_2021"), {
        status: 200,
        headers: { "content-type": "text/xml" },
      }),
      { contract: "old", operation: "GetDistributionConfig" },
      { encoded: false, method: "GET" },
    );
    expect(await response.text()).toBe(DOCUMENT("TLSv1.2_2018"));
    expect(response.headers.get("invariant-folded")).toBe(
      "DistributionConfig/ViewerCertificate/MinimumProtocolVersion",
    );
  });

  it("gets a field the new contract requires written into it, named as the contract names it", async () => {
    const before = cloudfront("2020-05-31", PROTOCOLS);
    const after = cloudfront("2020-05-31", PROTOCOLS, {
      Staging: { type: "boolean", xml: { name: "IsStaging" } },
    });
    const required = structuredClone(after);
    (
      (
        required as unknown as {
          components: { schemas: Record<string, { required?: string[] }> };
        }
      ).components.schemas["DistributionConfig"] as { required?: string[] }
    ).required = ["Staging"];
    const { program, issues } = chainProgram("cloudfront", "new", "sha256:1", [
      {
        label: "new",
        parent: "old",
        from: before,
        to: required,
        changes: [
          change("chg_staging", "DistributionConfig", [
            { op: "add", path: "/Staging", value: false },
          ]),
        ],
      },
    ]);
    expect(issues).toEqual([]);
    const runtime = createRuntime({
      program,
      identity: [{ kind: "default", label: "old" }],
    });
    const site = runtime.siteFor("old", "put", "/2020-05-31/distribution/E1/config");
    if (!site) throw new Error("no site");
    const sent = await runtime.adaptRequest(
      site,
      new Request("https://cloudfront.amazonaws.com/2020-05-31/distribution/E1/config", {
        method: "PUT",
        headers: { "content-type": "text/xml" },
        body: DOCUMENT("TLSv1"),
      }),
      {
        path: "/2020-05-31/distribution/E1/config",
        search: "",
        headers: new Headers({ "content-type": "text/xml" }),
      },
      { contract: "old", operation: "UpdateDistribution" },
    );
    expect(sent.body).toBe(
      DOCUMENT("TLSv1").replace(
        "\n  </ViewerCertificate>\n",
        "\n  </ViewerCertificate><IsStaging>false</IsStaging>\n",
      ),
    );
  });

  it("follows a renamed field from one element name to the other", () => {
    const before = cloudfront("2020-05-31", PROTOCOLS, {
      Note: { type: "string", xml: { name: "Remark" } },
    });
    const after = cloudfront("2020-05-31", PROTOCOLS, {
      Memo: { type: "string", xml: { name: "Memorandum" } },
    });
    const { program, issues } = chainProgram("cloudfront", "new", "sha256:1", [
      {
        label: "new",
        parent: "old",
        from: before,
        to: after,
        changes: [
          change("chg_memo", "DistributionConfig", [
            { op: "move", from: "/Note", to: "/Memo" },
          ]),
        ],
      },
    ]);
    expect(issues).toEqual([]);
    const request =
      program.contracts["old"]?.sites["put /2020-05-31/distribution/{Id}/config"]?.xml
        ?.request;
    expect(
      request?.read.properties?.["DistributionConfig"]?.properties?.["Note"],
    ).toEqual({
      type: "string",
      name: "Remark",
    });
    expect(
      request?.write.properties?.["DistributionConfig"]?.properties?.["Memo"],
    ).toEqual({
      type: "string",
      name: "Memorandum",
    });
  });
});

describe("what an XML body cannot carry", () => {
  const change1 = (schema: string, ops: unknown[]) => change("chg_refused", schema, ops);
  const compile = (before: OpenApiDocument, after: OpenApiDocument, changes: Change[]) =>
    xmlIssues(before, after, changes).map((issue) => issue.message);

  it("refuses a map's values, which XML has no form for", () => {
    const tags = { type: "object", additionalProperties: { type: "string" } };
    const before = cloudfront("v", PROTOCOLS, { Tags: tags });
    const after = cloudfront("v", PROTOCOLS, { Tags: tags });
    expect(
      compile(before, after, [
        change1("DistributionConfig", [
          {
            op: "convert",
            path: "/Tags/{}",
            codec: { kind: "stringCase", from: "snake", to: "kebab" },
          },
        ]),
      ]).join(),
    ).toContain("map's values");
  });

  it("refuses to read a value whose contract says nothing of what it is", () => {
    const before = cloudfront("v", PROTOCOLS, { Status: {} });
    const after = cloudfront("v", PROTOCOLS, { Status: { type: "string" } });
    expect(
      compile(before, after, [
        change1("DistributionConfig", [
          {
            op: "convert",
            path: "/Status",
            codec: { kind: "stringCase", from: "snake", to: "kebab" },
          },
        ]),
      ]).join(),
    ).toContain("does not say what it holds");
  });

  it("refuses a schema that contains itself, whose places no description can list", () => {
    const origin = {
      type: "object",
      properties: {
        Name: { type: "string" },
        Failover: { $ref: "#/components/schemas/Origin" },
      },
    };
    const before = cloudfront("v", PROTOCOLS, {
      Origin: { $ref: "#/components/schemas/Origin" },
    });
    const after = cloudfront("v", PROTOCOLS, {
      Origin: { $ref: "#/components/schemas/Origin" },
    });
    for (const document of [before, after]) {
      (
        document as unknown as { components: { schemas: Record<string, unknown> } }
      ).components.schemas["Origin"] = origin;
    }
    expect(
      compile(before, after, [
        change1("Origin", [
          {
            op: "convert",
            path: "/Name",
            codec: { kind: "stringCase", from: "snake", to: "kebab" },
          },
        ]),
      ]).join(),
    ).toContain("shared block");
  });

  it("asks nothing of a contract with no XML in it", () => {
    const json = JSON.parse(
      JSON.stringify(cloudfront("v", PROTOCOLS)).replaceAll(
        "text/xml",
        "application/json",
      ),
    );
    expect(compile(json, json, [])).toEqual([]);
  });
});
