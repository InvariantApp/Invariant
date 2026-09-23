/**
 * An operation that answers with another success status.
 *
 * The prediction moves the old contract's response to the status the
 * operation answers with now, the projection answers an old caller the status
 * it was promised, with no body where it was promised none, and the release's
 * other response work is filed under the status the provider answers with.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { type Change, isJsonObject, parseChange } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { chainProgram } from "./chain.ts";
import { derive } from "./derive.ts";
import { predictDocument } from "./predict.ts";
import { projectStep } from "./project.ts";

type Responses = Record<string, { description: string; content?: unknown }>;

const json = (ref: string) => ({
  "application/json": { schema: { $ref: `#/components/schemas/${ref}` } },
});

/** A contract with one operation, `post /variables/{name}`, answering as given. */
const contract = (
  responses: Responses,
  schemas: Record<string, unknown> = {},
  path = "/variables/{name}",
): OpenApiDocument =>
  ({
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      [path]: {
        post: {
          operationId: "createVariable",
          parameters: [
            { name: "name", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { ...responses, "404": { description: "gone" } },
        },
      },
    },
    components: {
      schemas: {
        Variable: {
          type: "object",
          required: ["name", "amount"],
          properties: { name: { type: "string" }, amount: { type: "integer" } },
        },
        ...schemas,
      },
    },
  }) as unknown as OpenApiDocument;

const status = (from: string, to: string, extra: Change["ops"] = []) =>
  parseChange({
    irVersion: 1,
    id: "chg_created",
    summary: "Creating a variable answers another status.",
    ops: [
      { op: "status", endpoint: { method: "post", path: "/variables/{name}" }, from, to },
      ...extra,
    ],
  });

const responsesOf = (document: OpenApiDocument, path = "/variables/{name}") => {
  const paths = document["paths"];
  const item = isJsonObject(paths) ? paths[path] : undefined;
  const operation = isJsonObject(item) ? item["post"] : undefined;
  return isJsonObject(operation)
    ? (operation["responses"] as Record<string, unknown>)
    : {};
};

const NO_BODY = { "204": { description: "created" } };
const CREATED = { "201": { description: "created", content: json("Variable") } };

describe("a success status that changed", () => {
  it("is predicted as the old response, at the status the operation answers with now", () => {
    const prediction = predictDocument(contract(NO_BODY), contract(CREATED), [
      status("204", "201"),
    ]);
    expect(prediction.issues).toEqual([]);
    expect(Object.keys(responsesOf(prediction.document)).sort()).toEqual(["201", "404"]);
    expect(responsesOf(prediction.document)["201"]).toEqual(NO_BODY["204"]);
  });

  it("answers an old caller the status it was promised, and no body where it was promised none", () => {
    const projected = projectStep(
      "old",
      contract(NO_BODY),
      [status("204", "201")],
      contract(CREATED),
    );
    expect(projected.issues).toEqual([]);
    expect(projected.program.sites["post /variables/{name}"]).toEqual({
      status: [{ from: 201, to: 204, empty: true, c: "chg_created" }],
    });
  });

  it("serves a body both statuses carry, with the work for it filed under the provider's status", () => {
    const old = contract({ "200": { description: "ok", content: json("Variable") } });
    const next = contract(CREATED, {
      Variable: {
        type: "object",
        required: ["name", "amount_cents"],
        properties: { name: { type: "string" }, amount_cents: { type: "integer" } },
      },
    });
    const renamed = parseChange({
      irVersion: 1,
      id: "chg_cents",
      summary: "amount is amount_cents",
      scopes: [{ schema: "#/components/schemas/Variable" }],
      ops: [{ op: "move", from: "/amount", to: "/amount_cents" }],
    });
    const changes = [renamed, status("200", "201")];
    expect(predictDocument(old, next, changes).issues).toEqual([]);
    const site = projectStep("old", old, changes, next).program.sites[
      "post /variables/{name}"
    ];
    expect(site?.status).toEqual([{ from: 201, to: 200, c: "chg_created" }]);
    expect(Object.keys(site?.response ?? {})).toEqual(["201"]);
    expect(JSON.stringify(site?.response?.["201"])).toContain('"from":"/amount_cents"');
  });

  it("answers the status the old server used where the old contract listed both", () => {
    // Gitea 1.24 listed 201 and 204 for creating a variable and answered 204;
    // 1.25 lists and answers 201.
    const old = contract({ ...NO_BODY, "201": { description: "created" } });
    const prediction = predictDocument(old, contract(CREATED), [status("204", "201")]);
    expect(prediction.issues).toEqual([]);
    expect(Object.keys(responsesOf(prediction.document)).sort()).toEqual(["201", "404"]);
    expect(
      projectStep("old", old, [status("204", "201")], contract(CREATED)).program.sites[
        "post /variables/{name}"
      ]?.status,
    ).toEqual([{ from: 201, to: 204, empty: true, c: "chg_created" }]);
  });

  it("follows the operation to where a route moved it", () => {
    const moved = parseChange({
      irVersion: 1,
      id: "chg_moved",
      summary: "variables moved",
      ops: [
        {
          op: "route",
          from: { method: "post", path: "/variables/{name}" },
          to: { method: "post", path: "/actions/variables/{name}" },
        },
      ],
    });
    const next = contract(CREATED, {}, "/actions/variables/{name}");
    const changes = [moved, status("204", "201")];
    const prediction = predictDocument(contract(NO_BODY), next, changes);
    expect(prediction.issues).toEqual([]);
    expect(
      Object.keys(responsesOf(prediction.document, "/actions/variables/{name}")),
    ).toContain("201");
    const sites = projectStep("old", contract(NO_BODY), changes, next).program.sites;
    expect(sites["post /actions/variables/{name}"]?.status).toEqual([
      { from: 201, to: 204, empty: true, c: "chg_created" },
    ]);
  });

  it("is exact at runtime, and asks a person to change code that checks the status", () => {
    const derived = derive(status("204", "201"));
    expect(derived.runtime).toBe("exact");
    expect(derived.source).toBe("assisted");
  });

  describe("is refused", () => {
    const refusal = (old: Responses, next: Responses, from: string, to: string) =>
      predictDocument(contract(old), contract(next), [status(from, to)]).issues.map(
        (issue) => issue.message,
      );

    it("where the old contract promised a body and the new status carries none", () => {
      expect(
        refusal(
          { "200": { description: "ok", content: json("Variable") } },
          NO_BODY,
          "200",
          "204",
        ),
      ).toEqual([expect.stringContaining("promised a body with 200")]);
    });

    it("where the old contract never answered the status it names", () => {
      expect(refusal(NO_BODY, CREATED, "200", "201")).toEqual([
        expect.stringContaining("never answered 200"),
      ]);
    });

    it("where the operation still answers the old status", () => {
      expect(refusal(NO_BODY, { ...NO_BODY, ...CREATED }, "204", "201")).toEqual([
        expect.stringContaining("still answers 204"),
      ]);
    });

    it("where the new contract does not answer the status it names", () => {
      expect(refusal(NO_BODY, CREATED, "204", "202")).toEqual([
        expect.stringContaining("does not answer 202"),
      ]);
    });

    it("where it changes nothing", () => {
      expect(refusal(NO_BODY, NO_BODY, "204", "204")).toEqual([
        expect.stringContaining("nothing changed"),
      ]);
    });

    it("and then the old contract's site gets no rule", () => {
      const projected = projectStep(
        "old",
        contract({ "200": { description: "ok", content: json("Variable") } }),
        [status("200", "204")],
        contract(NO_BODY),
      );
      expect(projected.program.sites).toEqual({});
    });
  });
});

describe("a status that changed in two releases", () => {
  it("is answered through both rules, and each release's body work runs for it", () => {
    const v1 = contract({ "200": { description: "ok", content: json("Variable") } });
    const v2 = contract(
      { "201": { description: "created", content: json("Variable") } },
      {
        Variable: {
          type: "object",
          required: ["name", "amount_cents"],
          properties: { name: { type: "string" }, amount_cents: { type: "integer" } },
        },
      },
    );
    const v3 = contract(
      { "202": { description: "accepted", content: json("Variable") } },
      {
        Variable: {
          type: "object",
          required: ["name", "cents"],
          properties: { name: { type: "string" }, cents: { type: "integer" } },
        },
      },
    );
    const rename = (id: string, from: string, to: string) =>
      parseChange({
        irVersion: 1,
        id,
        summary: "renamed",
        scopes: [{ schema: "#/components/schemas/Variable" }],
        ops: [{ op: "move", from, to }],
      });
    const moved = (id: string, from: string, to: string) =>
      parseChange({
        irVersion: 1,
        id,
        summary: "another status",
        ops: [
          {
            op: "status",
            endpoint: { method: "post", path: "/variables/{name}" },
            from,
            to,
          },
        ],
      });
    const chained = chainProgram("t", "v3", "sha256:0", [
      {
        label: "v2",
        parent: "v1",
        from: v1,
        to: v2,
        changes: [
          rename("chg_cents", "/amount", "/amount_cents"),
          moved("chg_201", "200", "201"),
        ],
      },
      {
        label: "v3",
        parent: "v2",
        from: v2,
        to: v3,
        changes: [
          rename("chg_short", "/amount_cents", "/cents"),
          moved("chg_202", "201", "202"),
        ],
      },
    ]);
    expect(chained.issues).toEqual([]);
    const site = chained.program.contracts["v1"]?.sites["post /variables/{name}"];
    expect(site?.status).toEqual([
      { from: 202, to: 201, c: "chg_202" },
      { from: 201, to: 200, c: "chg_201" },
    ]);
    // The provider answers 202: v3's work first, then v2's, as a response
    // undoes the later release first.
    const text = JSON.stringify(site?.response?.["202"]);
    expect(text).toContain("chg_short");
    expect(text).toContain("chg_cents");
    expect(text.indexOf("chg_short")).toBeLessThan(text.indexOf("chg_cents"));
    expect(chained.program.minRuntime).toMatch(/-next$/);
  });
});
