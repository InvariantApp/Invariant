/**
 * Drafts that need no decision, because no value has to be invented.
 *
 * Each case is one that stayed unexplained across the real corpus although
 * nothing about it was a judgement: a field added to a schema that only ever
 * appears in responses, a field removed from one that only ever appears in
 * requests with nothing added in its place, and an operation renamed where it
 * stood. Anything else still goes to a person.
 */
import type { OpenApiDocument } from "@invariant-app/contract";
import { describe, expect, it } from "vitest";
import { decisionChange } from "./decisions.ts";
import type { Judge } from "./judge.ts";
import { propose } from "./propose.ts";
import { RulesJudge } from "./rules.ts";
import { CHOOSE_ONE } from "./vocabulary.ts";

type Schema = Record<string, unknown>;

function contract(
  schemas: Record<string, Schema>,
  operationIds = { get: "getThing", post: "createThing" },
  /** The request body written in place, where it no longer names `ThingCreate`. */
  written?: Schema,
) {
  const body = (name: string) => ({
    content: {
      "application/json": {
        schema:
          name === "ThingCreate" && written
            ? written
            : { $ref: `#/components/schemas/${name}` },
      },
    },
  });
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: {
      "/things": {
        post: {
          operationId: operationIds.post,
          requestBody: body("ThingCreate"),
          responses: { "201": { description: "made", ...body("Shared") } },
        },
      },
      "/things/{id}": {
        get: {
          operationId: operationIds.get,
          responses: { "200": { description: "one", ...body("Thing") } },
        },
      },
    },
    components: { schemas },
  } as unknown as OpenApiDocument;
}

/** The object at a path in a document, for tests that rewrite one place in it. */
function pathAt(document: unknown, path: string[]): Record<string, unknown> {
  let at = document as Record<string, unknown>;
  for (const segment of path) at = at[segment] as Record<string, unknown>;
  return at;
}

const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const base = {
  Webhook: object({ id: { type: "string" } }),
  Thing: object({ id: { type: "string" } }, ["id"]),
  ThingCreate: object({ name: { type: "string" }, legacy: { type: "string" } }),
  Shared: object({ id: { type: "string" } }, ["id"]),
};

async function drafts(
  after: Record<string, Schema>,
  ids?: { get: string; post: string },
) {
  return propose(contract(base), contract({ ...base, ...after }, ids), {
    judge: new RulesJudge(),
  });
}

describe("a new required field", () => {
  it("is taken out of old callers' responses where the schema is only ever a response", async () => {
    const outcome = await drafts({
      Thing: object({ id: { type: "string" }, region: { type: "string" } }, [
        "id",
        "region",
      ]),
    });
    const change = outcome.proposals.find((proposal) =>
      proposal.change.id.includes("region"),
    );
    expect(change?.change.ops).toEqual([{ op: "add", path: "/region", value: null }]);
    expect(change?.change.scopes).toEqual([{ schema: "#/components/schemas/Thing" }]);
  });

  it("is given the specification's default where old callers send the schema", async () => {
    const outcome = await drafts({
      ThingCreate: object(
        {
          name: { type: "string" },
          legacy: { type: "string" },
          tier: { type: "string", default: "basic" },
        },
        ["tier"],
      ),
    });
    const change = outcome.proposals.find((proposal) =>
      proposal.change.id.includes("tier"),
    );
    expect(change?.change.ops).toEqual([{ op: "add", path: "/tier", value: "basic" }]);
  });

  it("is left to a person where a value would have to be invented", async () => {
    const outcome = await drafts({
      ThingCreate: object(
        {
          name: { type: "string" },
          legacy: { type: "string" },
          tier: { type: "string" },
        },
        ["tier"],
      ),
    });
    expect(
      outcome.proposals.some((proposal) => proposal.change.id.includes("tier")),
    ).toBe(false);
    // Asked as a decision with the Change drafted around the answer.
    const decision = outcome.decisions.find((entry) => entry.field === "tier");
    expect(decision).toMatchObject({ kind: "value", op: { op: "add" } });
    expect(decision && decisionChange(decision).ops).toEqual([
      { op: "add", path: "/tier", value: CHOOSE_ONE },
    ]);
  });
});

describe("a removed field with nothing added in its place", () => {
  it("is dropped from old callers' requests where the schema is only ever a request", async () => {
    const outcome = await drafts({ ThingCreate: object({ name: { type: "string" } }) });
    const change = outcome.proposals.find((proposal) =>
      proposal.change.id.includes("legacy"),
    );
    expect(change?.change.ops).toEqual([{ op: "remove", path: "/legacy" }]);
  });

  it("is left to a person where old callers were always given it", async () => {
    const outcome = await drafts({ Thing: object({}) });
    expect(
      outcome.proposals.some((proposal) => proposal.change.id.includes("thing_id")),
    ).toBe(false);
    const decision = outcome.decisions.find((entry) => entry.field === "id");
    expect(decision && decisionChange(decision).ops).toEqual([
      { op: "remove", path: "/id", restore: CHOOSE_ONE },
    ]);
  });
});

describe("a removed field beside fields that were added", () => {
  // PayPal's orders API dropped `payer.address.address_details` in the release
  // that added other address fields. Whether one became another is the
  // judge's question; when no judge will say, the drop is still drafted, for
  // a person to confirm, rather than nothing at all.
  it("is drafted as dropped from requests, for explicit review, and still asked about", async () => {
    const outcome = await drafts({
      ThingCreate: object({ name: { type: "string" }, colour: { type: "string" } }),
    });
    const draft = outcome.proposals.find((proposal) =>
      proposal.change.id.includes("legacy"),
    );
    expect(draft?.change.ops).toEqual([{ op: "remove", path: "/legacy" }]);
    expect(draft?.attention).toBe("explicit");
    // Still an open question: it may be `colour`, renamed.
    expect(outcome.unresolved.map((entry) => entry.field)).toContain("legacy");
  });

  it("is not drafted where the schema was replaced by another of the same name", async () => {
    // PayPal's `payout_item`: the request item's name reused for a response
    // detail. Its fields were not dropped, they moved to a renamed schema.
    const sent = object({
      receiver: { type: "string" },
      amount: { type: "string" },
      note: { type: "string" },
      recipient_type: { type: "string" },
    });
    const reported = object({
      payout_item_id: { type: "string" },
      transaction_status: { type: "string" },
      time_processed: { type: "string" },
    });
    const outcome = await propose(
      contract({ ...base, ThingCreate: sent }),
      contract({ ...base, ThingCreate: reported }),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals.filter((p) => p.change.id.includes("removed"))).toEqual([]);
    // Still asked about: which schema did they go to?
    expect(outcome.unresolved.map((entry) => entry.field)).toContain("amount");
  });

  it("is not drafted where the schema became a choice between others holding it", async () => {
    // Datadog's topology map widget became a oneOf of two definitions, each
    // with the fields the one definition had.
    const variant = (kind: string) =>
      object({
        name: { type: "string" },
        legacy: { type: "string" },
        kind: { type: "string", enum: [kind] },
      });
    const outcome = await propose(
      contract(base),
      contract({
        ...base,
        StreamsCreate: variant("streams"),
        MapCreate: variant("map"),
        ThingCreate: {
          oneOf: [
            { $ref: "#/components/schemas/StreamsCreate" },
            { $ref: "#/components/schemas/MapCreate" },
          ],
        },
      }),
      { judge: new RulesJudge() },
    );
    expect(
      [
        ...outcome.proposals.map((p) => p.change),
        ...outcome.decisions.map(decisionChange),
      ]
        .flatMap((change) => change.ops)
        .filter((op) => op.op === "remove"),
    ).toEqual([]);
  });

  it("is drafted where the schema stayed a choice and lost a base no variant holds", async () => {
    // Okta's signing key request kept its oneOf and lost the allOf base that
    // held `kid`; no variant has it, so it was removed.
    const variant = (kty: string) => object({ kty: { type: "string", enum: [kty] } });
    const choice = (extra: Schema) => ({
      ...extra,
      oneOf: [
        { $ref: "#/components/schemas/RsaCreate" },
        { $ref: "#/components/schemas/EcCreate" },
      ],
    });
    const keys = { RsaCreate: variant("RSA"), EcCreate: variant("EC") };
    const outcome = await propose(
      contract({
        ...base,
        ...keys,
        KeyBase: object({ kid: { type: "string" } }),
        ThingCreate: choice({ allOf: [{ $ref: "#/components/schemas/KeyBase" }] }),
      }),
      contract({ ...base, ...keys, ThingCreate: choice({}) }),
      { judge: new RulesJudge() },
    );
    expect(
      outcome.proposals.map((p) => p.change.ops).filter((ops) => ops[0]?.op === "remove"),
    ).toEqual([[{ op: "remove", path: "/kid" }]]);
  });

  it("is a decision where old callers' responses always carried it", async () => {
    const outcome = await drafts({
      Thing: object({ colour: { type: "string" } }, ["colour"]),
    });
    const decision = outcome.decisions.find((entry) => entry.field === "id");
    expect(decision && decisionChange(decision).ops).toEqual([
      { op: "remove", path: "/id", restore: CHOOSE_ONE },
    ]);
  });
});

describe("a field a schema inherits through allOf", () => {
  // Figma declares `devStatus` once, on a trait eight node schemas are built
  // from. A value it gains is one question, asked where it is declared.
  it("is asked about once, where it is declared", async () => {
    const trait = (values: string[]) =>
      object({ status: { type: "string", enum: values } }, ["status"]);
    const node = { allOf: [{ $ref: "#/components/schemas/StatusTrait" }] };
    const outcome = await propose(
      contract({
        ...base,
        StatusTrait: trait(["NONE", "READY"]),
        Thing: node,
        Shared: node,
      }),
      contract({
        ...base,
        StatusTrait: trait(["NONE", "READY", "DONE"]),
        Thing: node,
        Shared: node,
      }),
      { judge: new RulesJudge() },
    );
    expect(outcome.decisions.map((decision) => decisionChange(decision).id)).toEqual([
      expect.stringContaining("status_trait"),
    ]);
  });

  // Okta's email-server request was built from `BaseEmailServer`, and then
  // replaced by it: the request body itself now requires what it did not.
  it("is its own to change once it is no longer built from there", async () => {
    const server = (required: string[]) =>
      object({ alias: { type: "string" }, host: { type: "string" } }, required);
    const outcome = await propose(
      contract({
        ...base,
        BaseServer: server([]),
        ThingCreate: { allOf: [{ $ref: "#/components/schemas/BaseServer" }] },
      }),
      contract({
        ...base,
        BaseServer: server(["alias"]),
        ThingCreate: server(["alias"]),
      }),
      { judge: new RulesJudge() },
    );
    const about = [
      ...outcome.decisions.map((decision) => decisionChange(decision).id),
      ...outcome.proposals.map((proposal) => proposal.change.id),
    ];
    expect(about).toContainEqual(expect.stringContaining("thing_create"));
  });
});

describe("a schema kept for requests and replaced for responses", () => {
  // Adyen kept `AfterpayTouchInfo` for requests and gave responses a new
  // `AfterpayTouchResponseInfo`, in which `supportUrl` is optional.
  const info = (required: string[]) =>
    object(
      { supportUrl: { type: "string" }, supportEmail: { type: "string" } },
      required,
    );
  const holder = (name: string) =>
    object(
      { id: { type: "string" }, afterpay: { $ref: `#/components/schemas/${name}` } },
      ["id"],
    );

  it("asks what old callers' responses show where a field they were promised may be missing", async () => {
    const outcome = await propose(
      contract({
        ...base,
        Info: info(["supportUrl"]),
        ThingCreate: holder("Info"),
        Shared: holder("Info"),
      }),
      contract({
        ...base,
        Info: info(["supportUrl"]),
        InfoResponse: info([]),
        ThingCreate: holder("Info"),
        Shared: holder("InfoResponse"),
      }),
      { judge: new RulesJudge() },
    );
    const decision = outcome.decisions.find((entry) => entry.field === "supportUrl");
    expect(decision && decisionChange(decision).ops).toEqual([
      {
        op: "default",
        path: "/supportUrl",
        value: CHOOSE_ONE,
        when: "absent",
        toward: "old",
      },
    ]);
    expect(decision && decisionChange(decision).scopes).toEqual([
      { schema: "#/components/schemas/Info" },
    ]);
  });

  it("drafts nothing that would act on the requests, where nothing changed", async () => {
    const outcome = await propose(
      contract({
        ...base,
        Info: info([]),
        ThingCreate: holder("Info"),
        Shared: holder("Info"),
      }),
      contract({
        ...base,
        Info: info([]),
        InfoResponse: object({ supportUrl: { type: "string" } }),
        ThingCreate: holder("Info"),
        Shared: holder("InfoResponse"),
      }),
      { judge: new RulesJudge() },
    );
    expect(
      [
        ...outcome.proposals.map((p) => p.change),
        ...outcome.decisions.map(decisionChange),
      ]
        .flatMap((change) => change.scopes ?? [])
        .filter((scope) => JSON.stringify(scope).includes('/Info"')),
    ).toEqual([]);
  });
});

describe("a field that stopped stating its values or its type", () => {
  // Mistral's fine-tuning `model` went from nine names to any string.
  it("is declared with a relax where old callers are sent it", async () => {
    const before = await propose(
      contract({
        ...base,
        Thing: object(
          { id: { type: "string" }, model: { type: "string", enum: ["a", "b"] } },
          ["id"],
        ),
      }),
      contract({
        ...base,
        Thing: object({ id: { type: "string" }, model: { type: "string" } }, ["id"]),
      }),
      { judge: new RulesJudge() },
    );
    const change = before.proposals.find((proposal) =>
      proposal.change.id.includes("model"),
    );
    expect(change?.change.ops).toEqual([
      { op: "relax", path: "/model", set: { enum: null } },
    ]);
    expect(before.unresolved).toEqual([]);
  });

  it("is declared where the values were a named schema's, and the field now refers to none", async () => {
    const names = { type: "string", enum: ["small", "large"] };
    const outcome = await propose(
      contract({
        ...base,
        ModelName: names,
        Thing: object({
          id: { type: "string" },
          model: { $ref: "#/components/schemas/ModelName" },
        }),
      }),
      contract({
        ...base,
        ModelName: names,
        Thing: object({ id: { type: "string" }, model: { type: "string" } }),
      }),
      { judge: new RulesJudge() },
    );
    const change = outcome.proposals.find((proposal) =>
      proposal.change.id.includes("model"),
    );
    expect(change?.change.ops).toEqual([
      { op: "relax", path: "/model", set: { enum: null } },
    ]);
  });

  // Twilio's free-form objects lost `type: object`.
  it("is declared with a relax where a response's value lost its type", async () => {
    const outcome = await propose(
      contract({
        ...base,
        Thing: object({ id: { type: "string" }, extra: { type: "object" } }),
      }),
      contract({ ...base, Thing: object({ id: { type: "string" }, extra: {} }) }),
      { judge: new RulesJudge() },
    );
    const change = outcome.proposals.find((proposal) =>
      proposal.change.id.includes("extra"),
    );
    expect(change?.change.ops).toEqual([
      { op: "relax", path: "/extra", set: { type: null } },
    ]);
  });

  it("needs nothing where only old callers' requests carry it", async () => {
    const outcome = await propose(
      contract({
        ...base,
        ThingCreate: object({ name: { type: "string", enum: ["a", "b"] } }),
      }),
      contract({ ...base, ThingCreate: object({ name: { type: "string" } }) }),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals.filter((p) => p.change.id.includes("name"))).toEqual([]);
    expect(outcome.unresolved).toEqual([]);
  });
});

describe("objects written in place that became references", () => {
  // PayPal moved an invoice written out in full into named schemas, one
  // referring to the next: nothing a caller sends or receives changed.
  it("drafts nothing, however deep the references go", async () => {
    const address = object({ country_code: { type: "string" } }, ["country_code"]);
    const party = (a: Schema) => object({ name: { type: "string" }, address: a });
    const outcome = await propose(
      contract({
        ...base,
        Thing: object({ id: { type: "string" }, invoicer: party(address) }),
      }),
      contract({
        ...base,
        Address: address,
        Party: party({ $ref: "#/components/schemas/Address" }),
        Thing: object({
          id: { type: "string" },
          invoicer: { $ref: "#/components/schemas/Party" },
        }),
      }),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals).toEqual([]);
    expect(outcome.decisions).toEqual([]);
  });

  it("still finds what changed inside them", async () => {
    // A request field old callers could leave out, now required inside the
    // schema the object became.
    const address = (required: string[]) =>
      object({ country_code: { type: "string" } }, required);
    const outcome = await propose(
      contract({
        ...base,
        ThingCreate: object({ name: { type: "string" }, address: address([]) }),
      }),
      contract({
        ...base,
        Address: address(["country_code"]),
        ThingCreate: object({
          name: { type: "string" },
          address: { $ref: "#/components/schemas/Address" },
        }),
      }),
      { judge: new RulesJudge() },
    );
    const decision = outcome.decisions.find(
      (entry) => entry.field === "address.country_code",
    );
    expect(decision && decisionChange(decision).ops).toEqual([
      {
        op: "default",
        path: "/address/country_code",
        value: CHOOSE_ONE,
        when: "absent",
        toward: "new",
      },
    ]);
  });
});

describe("references written out in place", () => {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const opsBy = (outcome: Awaited<ReturnType<typeof propose>>) =>
    outcome.proposals.map((proposal) => ({
      scope: proposal.change.scopes?.[0],
      ops: proposal.change.ops,
    }));

  it("reads what the schema held, and leaves what it changed itself to it (PayPal's phone)", async () => {
    // The phone number, written out where `phone_with_type` had referred to
    // `phone`, lost its country code with `phone`, and always had its
    // national number through it.
    const phone = (fields: string[]) =>
      object(
        Object.fromEntries(fields.map((field) => [field, { type: "string" }])),
        fields,
      );
    const schemas = (typed: Schema, number: string[]) => ({
      ...base,
      Phone: phone(number),
      Typed: typed,
      ThingCreate: object({ name: { type: "string" }, phone: ref("Typed") }),
      Thing: object({ id: { type: "string" }, phone: ref("Typed") }, ["id"]),
    });
    const outcome = await propose(
      contract(
        schemas(object({ number: ref("Phone") }, ["number"]), [
          "country_code",
          "national_number",
        ]),
      ),
      contract(
        schemas(object({ number: phone(["national_number"]) }, ["number"]), [
          "national_number",
        ]),
      ),
      { judge: new RulesJudge() },
    );
    // One question, where the country code went; nothing where it was used.
    expect(
      outcome.decisions.map((decision) => [decision.schema, decision.field]),
    ).toEqual([["Phone", "country_code"]]);
    expect(outcome.proposals).toEqual([]);
  });

  it("compares each place as what it holds now, where the places differ (PayPal's name)", async () => {
    // One `name`, written out as a payer's given name and surname, and as a
    // shipping name's full name alone.
    const name = object({
      given_name: { type: "string" },
      surname: { type: "string" },
      full_name: { type: "string" },
    });
    const outcome = await propose(
      contract({
        ...base,
        Name: name,
        ThingCreate: object({ payer: ref("Name"), shipping: ref("Name") }),
      }),
      contract({
        ...base,
        ThingCreate: object({
          payer: object({ given_name: { type: "string" }, surname: { type: "string" } }),
          shipping: object({ full_name: { type: "string" } }),
        }),
      }),
      { judge: new RulesJudge() },
    );
    const removed = opsBy(outcome).flatMap(({ scope, ops }) =>
      ops.map((op) => `${JSON.stringify(scope)} ${op.op} ${"path" in op ? op.path : ""}`),
    );
    expect(removed.sort()).toEqual(
      ["/payer/full_name", "/shipping/given_name", "/shipping/surname"].map(
        (path) => `{"schema":"#/components/schemas/ThingCreate"} remove ${path}`,
      ),
    );
  });

  it("compares a request body written out in place with the schema it named (Okta's group)", async () => {
    // A group was created from a `Group`, and later from an object holding
    // its name alone, while `Group` stayed as it was.
    const outcome = await propose(
      contract(base),
      contract(base, undefined, {
        type: "object",
        properties: { name: { type: "string" } },
      }),
      { judge: new RulesJudge() },
    );
    expect(opsBy(outcome)).toEqual([
      {
        scope: { operation: "createThing", location: "body" },
        ops: [{ op: "remove", path: "/legacy" }],
      },
    ]);
  });

  it("drafts once what the named schema changed itself, not again at the body", async () => {
    const outcome = await propose(
      contract(base),
      contract(
        { ...base, ThingCreate: object({ name: { type: "string" } }) },
        undefined,
        { type: "object", properties: { name: { type: "string" } } },
      ),
      { judge: new RulesJudge() },
    );
    expect(opsBy(outcome)).toEqual([
      {
        scope: { schema: "#/components/schemas/ThingCreate" },
        ops: [{ op: "remove", path: "/legacy" }],
      },
    ]);
  });
});

describe("a field that points at a different schema", () => {
  // Datadog's `last_revision` went from CustomRuleRevision to
  // CustomRuleRevisionInput, and both schemas stayed.
  it("is compared with the one it points at now", async () => {
    const revision = (fields: Record<string, Schema>, required: string[]) =>
      object(fields, required);
    const holder = (name: string) =>
      object({
        id: { type: "string" },
        last_revision: { $ref: `#/components/schemas/${name}` },
      });
    const outcome = await propose(
      contract({
        ...base,
        Revision: revision({ type: { type: "string" } }, ["type"]),
        RevisionInput: revision({ checksum: { type: "string" } }, ["checksum"]),
        Thing: holder("Revision"),
      }),
      contract({
        ...base,
        Revision: revision({ type: { type: "string" } }, ["type"]),
        RevisionInput: revision({ checksum: { type: "string" } }, ["checksum"]),
        Thing: holder("RevisionInput"),
      }),
      { judge: new RulesJudge() },
    );
    const ops = [
      ...outcome.proposals.map((p) => p.change),
      ...outcome.decisions.map(decisionChange),
    ]
      .filter((change) => JSON.stringify(change.scopes).includes("/Thing"))
      .flatMap((change) => change.ops);
    expect(ops).toContainEqual({
      op: "add",
      path: "/last_revision/checksum",
      value: null,
    });
    expect(ops).toContainEqual({
      op: "remove",
      path: "/last_revision/type",
      restore: CHOOSE_ONE,
    });
  });
});

describe("a named list of a choice that did not change", () => {
  // Datadog's `display_block` names `LLMObsContentBlocks`, a list of
  // `LLMObsContentBlock`, which is a choice between two blocks. Nothing
  // about any of them changed, and every later Datadog release still drafted
  // `display_block.*.type` as newly required: the list's own reference was
  // read as if it were its items'.
  it("drafts nothing", async () => {
    const schemas = {
      ...base,
      Thing: object(
        { id: { type: "string" }, blocks: { $ref: "#/components/schemas/Blocks" } },
        ["id", "blocks"],
      ),
      Blocks: { type: "array", items: { $ref: "#/components/schemas/Block" } },
      Block: {
        ...object({ type: { type: "string" }, url: { type: "string" } }, ["type"]),
        anyOf: [
          { $ref: "#/components/schemas/Frontend" },
          { $ref: "#/components/schemas/Legacy" },
        ],
      },
      Frontend: object({ code: { type: "string" }, type: { type: "string" } }, ["code"]),
      Legacy: object({ type: { type: "string" } }),
    };
    const outcome = await propose(contract(schemas), contract(schemas), {
      judge: new RulesJudge(),
    });
    expect(outcome.proposals).toEqual([]);
    expect(outcome.decisions).toEqual([]);
  });
});

describe("a schema that stopped describing itself", () => {
  // Amazon replaced CloudDirectory's error schemas with `{}` between two
  // versions: an empty schema allows everything the old one did.
  it("is a declared loss, not every field removed", async () => {
    const outcome = await propose(
      contract({
        ...base,
        Thing: object({ id: { type: "string" }, note: { type: "string" } }, ["id"]),
      }),
      contract({ ...base, Thing: {} }),
      { judge: new RulesJudge() },
    );
    const ops = [
      ...outcome.proposals.map((p) => p.change),
      ...outcome.decisions.map(decisionChange),
    ]
      .filter((change) => JSON.stringify(change.scopes).includes("/Thing"))
      .flatMap((change) => change.ops);
    expect(ops).toEqual([{ op: "relax", path: "", set: { type: null } }]);
  });
});

describe("a response that now names a different schema", () => {
  // Plaid pointed three consent operations at `FDXError` and left the rest of
  // the API on the `PlaidError` they had all shared.
  const error = (values: string[]) =>
    object({ error_type: { type: "string", enum: values } }, ["error_type"]);
  const withError = (name: string) =>
    ({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: {
        "/consents": {
          get: {
            operationId: "listConsents",
            responses: {
              default: {
                description: "error",
                content: {
                  "application/json": {
                    schema: { $ref: `#/components/schemas/${name}` },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          PlaidError: error(["API_ERROR", "ITEM_ERROR"]),
          FdxError: error(["ITEM_ERROR"]),
        },
      },
    }) as unknown as OpenApiDocument;

  it("is compared with the one it now names, scoped to that response", async () => {
    const outcome = await propose(withError("PlaidError"), withError("FdxError"), {
      judge: new RulesJudge(),
    });
    const change = outcome.proposals.find((proposal) =>
      proposal.change.id.includes("error_type"),
    );
    expect(change?.change.scopes).toEqual([
      { operation: "listConsents", response: "default" },
    ]);
    expect(change?.change.ops).toEqual([
      { op: "relax", path: "/error_type", set: { enum: ["ITEM_ERROR"] } },
    ]);
  });

  it("is left to the variants where it became a choice between schemas", async () => {
    const asChoice = (document: OpenApiDocument) => {
      const copy = JSON.parse(JSON.stringify(document)) as Record<string, never>;
      const media = pathAt(copy, [
        "paths",
        "/consents",
        "get",
        "responses",
        "default",
        "content",
        "application/json",
      ]);
      media["schema"] = {
        oneOf: [
          { $ref: "#/components/schemas/PlaidError" },
          { $ref: "#/components/schemas/FdxError" },
        ],
      };
      return copy as unknown as OpenApiDocument;
    };
    const outcome = await propose(
      withError("PlaidError"),
      asChoice(withError("PlaidError")),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals).toEqual([]);
    expect(outcome.decisions).toEqual([]);
  });
});

describe("an operation renamed where it stood", () => {
  it("is recorded as a route with the new operationId", async () => {
    const outcome = await drafts({}, { get: "retrieveThing", post: "createThing" });
    const change = outcome.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "route"),
    );
    expect(change?.change.ops).toEqual([
      {
        op: "route",
        from: { method: "get", path: "/things/{id}" },
        to: { method: "get", path: "/things/{id}" },
        operationId: { from: "getThing", to: "retrieveThing" },
      },
    ]);
  });
});

describe("a whole API moved to a new prefix", () => {
  it("records each operation's renamed id on its route", async () => {
    const versioned = (version: string) =>
      ({
        openapi: "3.0.3",
        info: { title: "t", version },
        paths: Object.fromEntries(
          ["distribution", "invalidation", "origin"].map((name) => [
            `/${version}/${name}`,
            {
              get: {
                operationId: `Get${name}${version.replaceAll("-", "_")}`,
                responses: { "200": { description: "ok" } },
              },
            },
          ]),
        ),
      }) as unknown as OpenApiDocument;
    // How AWS CloudFront versions: the path and the operation id both carry it.
    const outcome = await propose(versioned("2016-11-25"), versioned("2017-03-25"), {
      judge: new RulesJudge(),
    });
    const routes = outcome.proposals.flatMap((proposal) =>
      proposal.change.ops.filter((op) => op.op === "route"),
    );
    expect(routes).toContainEqual({
      op: "route",
      from: { method: "get", path: "/2016-11-25/distribution" },
      to: { method: "get", path: "/2017-03-25/distribution" },
      operationId: { from: "Getdistribution2016_11_25", to: "Getdistribution2017_03_25" },
    });
  });
});

describe("a whole API moved under a prefix it did not have, or out of one", () => {
  const paths = (prefix: string) =>
    ({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: Object.fromEntries(
        ["meshes", "routes", "nodes"].map((name) => [
          `${prefix}/${name}`,
          {
            get: {
              operationId: `List${name}`,
              responses: { "200": { description: "ok" } },
            },
          },
        ]),
      ),
    }) as unknown as OpenApiDocument;
  const routes = async (before: string, after: string) =>
    (
      await propose(paths(before), paths(after), { judge: new RulesJudge() })
    ).proposals.flatMap((proposal) =>
      proposal.change.ops.filter((op) => op.op === "route"),
    );

  it("routes every endpoint under the new prefix, as AWS App Mesh versioned", async () => {
    expect(await routes("", "/v20190125")).toContainEqual({
      op: "route",
      from: { method: "get", path: "/meshes" },
      to: { method: "get", path: "/v20190125/meshes" },
    });
  });

  it("routes every endpoint out from under a prefix that was dropped", async () => {
    expect(await routes("/v1", "")).toContainEqual({
      op: "route",
      from: { method: "get", path: "/v1/meshes" },
      to: { method: "get", path: "/meshes" },
    });
  });
});

describe("nested fields", () => {
  const nestedBase = {
    ...base,
    ThingCreate: object({
      name: { type: "string" },
      shipping: object({ city: { type: "string" }, legacy_code: { type: "string" } }),
      lines: {
        type: "array",
        items: object({ sku: { type: "string" }, price: { type: "number" } }),
      },
    }),
  };
  const nested = async (after: Record<string, Schema>) =>
    propose(contract(nestedBase), contract({ ...nestedBase, ...after }), {
      judge: new RulesJudge(),
    });

  it("are followed into inline objects and lists", async () => {
    const outcome = await nested({
      ThingCreate: object({
        name: { type: "string" },
        shipping: object({ city: { type: "string" } }),
        lines: {
          type: "array",
          items: object({ sku: { type: "string" }, price: { type: "number" } }),
        },
      }),
    });
    const change = outcome.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "remove"),
    );
    expect(change?.change.ops).toEqual([{ op: "remove", path: "/shipping/legacy_code" }]);
  });

  it("are renamed where they sit, inside a list's items too", async () => {
    const outcome = await nested({
      ThingCreate: object({
        name: { type: "string" },
        shipping: object({ city: { type: "string" }, legacy_code: { type: "string" } }),
        lines: {
          type: "array",
          items: object({ sku: { type: "string" }, price_cents: { type: "integer" } }),
        },
      }),
    });
    const moves = outcome.proposals.flatMap((proposal) =>
      proposal.change.ops.filter((op) => op.op === "move"),
    );
    expect(moves).toContainEqual({
      op: "move",
      from: "/lines/*/price",
      to: "/lines/*/price_cents",
    });
  });

  it("are not followed into another named schema, which is compared as itself", async () => {
    const withRef = {
      ...base,
      Address: object({ city: { type: "string" }, zip: { type: "string" } }),
      Thing: object(
        { id: { type: "string" }, address: { $ref: "#/components/schemas/Address" } },
        ["id"],
      ),
    };
    const outcome = await propose(
      contract(withRef),
      contract({ ...withRef, Address: object({ city: { type: "string" } }) }),
      { judge: new RulesJudge() },
    );
    // Only Address speaks for its own fields; Thing never reaches into it.
    expect(
      outcome.unresolved
        .filter((entry) => entry.field.includes("zip"))
        .map((e) => e.schema),
    ).not.toContain("Thing");
  });
});

describe("a schema no operation uses", () => {
  it("gets no drafts, since the gate reports nothing for it", async () => {
    // Plaid documents its webhook payloads as schemas nothing refers to.
    const outcome = await drafts({
      Webhook: object({ environment: { type: "string" } }, ["environment"]),
    });
    expect(
      outcome.proposals.some((proposal) => proposal.change.id.includes("webhook")),
    ).toBe(false);
    expect(outcome.unresolved.some((entry) => entry.schema === "Webhook")).toBe(false);
  });
});

describe("a field that may now be left out or null, or no longer may", () => {
  const ops = async (after: Record<string, Schema>) =>
    (await drafts(after)).proposals.flatMap((proposal) => proposal.change.ops);

  it("sends old callers a now-nullable optional response field left out", async () => {
    const before = {
      ...base,
      Thing: object({ id: { type: "string" }, note: { type: "string" } }, ["id"]),
    };
    const outcome = await propose(
      contract(before),
      contract({
        ...before,
        Thing: object(
          { id: { type: "string" }, note: { type: "string", nullable: true } },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals.flatMap((proposal) => proposal.change.ops)).toEqual([
      { op: "dropNull", path: "/note", toward: "old" },
    ]);
  });

  it("gives old callers the declared default where a response field became optional", async () => {
    expect(
      await ops({
        Thing: object({ id: { type: "string", default: "unknown" } }, []),
      }),
    ).toEqual([
      { op: "default", path: "/id", value: "unknown", when: "absent", toward: "old" },
    ]);
  });

  it("leaves it to a person where a response field became optional with no default", async () => {
    const outcome = await drafts({ Thing: object({ id: { type: "string" } }, []) });
    const decision = outcome.decisions.find((entry) => entry.field === "id");
    expect(decision && decisionChange(decision).ops).toEqual([
      { op: "default", path: "/id", value: CHOOSE_ONE, when: "absent", toward: "old" },
    ]);
  });

  it("gives old callers' requests the default where a field became required", async () => {
    expect(
      await ops({
        ThingCreate: object(
          { name: { type: "string", default: "unnamed" }, legacy: { type: "string" } },
          ["name"],
        ),
      }),
    ).toEqual([
      { op: "default", path: "/name", value: "unnamed", when: "absent", toward: "new" },
    ]);
  });

  it("drops a null from old callers' requests where an optional field stopped being nullable", async () => {
    const before = {
      ...base,
      ThingCreate: object({ name: { type: "string", nullable: true } }),
    };
    const outcome = await propose(
      contract(before),
      contract({ ...before, ThingCreate: object({ name: { type: "string" } }) }),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals.flatMap((proposal) => proposal.change.ops)).toEqual([
      { op: "dropNull", path: "/name", toward: "new" },
    ]);
  });

  it("records a request field that now accepts null, with nothing to translate", async () => {
    expect(
      await ops({
        ThingCreate: object(
          { name: { type: "string", nullable: true }, legacy: { type: "string" } },
          ["name"],
        ),
      }),
    ).toEqual([{ op: "dropNull", path: "/name", toward: "old" }]);
  });

  it("drafts nothing where the change hurts no old caller", async () => {
    // A request field that became optional: old callers always send it.
    const before = {
      ...base,
      ThingCreate: object({ name: { type: "string" }, legacy: { type: "string" } }, [
        "name",
      ]),
    };
    const outcome = await propose(
      contract(before),
      contract({ ...before, ThingCreate: base.ThingCreate }),
      {
        judge: new RulesJudge(),
      },
    );
    expect(outcome.proposals).toEqual([]);
    expect(outcome.unresolved).toEqual([]);
  });
});

describe("an operation that kept its path and changed its method", () => {
  it("is routed, and its query parameters follow into the new body", async () => {
    const search = (method: string, operation: Record<string, unknown>) =>
      ({
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        paths: { "/search": { [method]: { operationId: "search", ...operation } } },
      }) as unknown as OpenApiDocument;
    const outcome = await propose(
      search("get", {
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "ok" } },
      }),
      search("post", {
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { q: { type: "string" } } },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      }),
      { judge: new RulesJudge() },
    );
    const ops = outcome.proposals.flatMap((proposal) => proposal.change.ops);
    expect(ops).toContainEqual({
      op: "route",
      from: { method: "get", path: "/search" },
      to: { method: "post", path: "/search" },
    });
    expect(ops).toContainEqual({ op: "move", from: "/q", to: "/@body/q" });
    // Not reported as retired as well.
    expect(ops.some((op) => op.op === "retire")).toBe(false);
  });

  it("drafts nothing for the body of an operation it retires", async () => {
    // Apicurio 2 moved its versions listing under `/groups/{groupId}` and kept
    // the operationId. That is a new endpoint with a parameter old callers
    // never send, so the old one is retired, and a body Change scoped to the
    // same id would point at an operation the predicted contract no longer has.
    const versions = (
      path: string,
      properties: Record<string, Schema>,
      required: string[] = [],
    ) =>
      ({
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        paths: {
          [path]: {
            get: {
              operationId: "listArtifactVersions",
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": { schema: object(properties, required) },
                  },
                },
              },
            },
          },
        },
      }) as unknown as OpenApiDocument;
    const outcome = await propose(
      versions("/artifacts/{artifactId}/versions", { id: { type: "string" } }),
      versions(
        "/groups/{groupId}/artifacts/{artifactId}/versions",
        {
          id: { type: "string" },
          count: { type: "integer" },
        },
        ["id", "count"],
      ),
      { judge: new RulesJudge() },
    );
    const changes = outcome.proposals.map((proposal) => proposal.change);
    expect(changes.flatMap((change) => change.ops)).toContainEqual({
      op: "retire",
      endpoint: { method: "get", path: "/artifacts/{artifactId}/versions" },
    });
    expect(changes.filter((change) => (change.scopes ?? []).length > 0)).toEqual([]);
  });
});

describe("a value that went and one that arrived", () => {
  it("is paired, and put in front of a person rather than assumed", async () => {
    // Adyen dropped `alma` and added `wero` in one release: two different
    // payment methods, which only a person can tell from a rename.
    const vocabulary = (values: string[]) =>
      object({ type: { type: "string", enum: values } }, ["type"]);
    const before = await propose(
      contract({ ...base, Thing: vocabulary(["alma", "card"]) }),
      contract({ ...base, Thing: vocabulary(["wero", "card"]) }),
      { judge: new RulesJudge() },
    );
    const renamed = before.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "convert"),
    );
    expect(renamed?.attention).toBe("explicit");
    expect(renamed?.confidence).toBeLessThan(1);
    expect(renamed?.notes.join(" ")).toContain("confirm");
  });
});

describe("a response union that can hold a new kind of object", () => {
  const typed = (value: string) =>
    object({ object: { type: "string", enum: [value] }, id: { type: "string" } }, [
      "object",
    ]);
  const expandable = (...variants: string[]) => ({
    anyOf: [
      { type: "string" },
      ...variants.map((name) => ({ $ref: `#/components/schemas/${name}` })),
    ],
  });
  const withUnion = (...variants: string[]) => ({
    ...base,
    Customer: typed("customer"),
    Guest: typed("guest"),
    Thing: object({ id: { type: "string" }, owner: expandable(...variants) }, ["id"]),
  });

  it("shows old callers the new kind as its id, where the union took an id", async () => {
    const outcome = await propose(
      contract(withUnion("Customer")),
      contract(withUnion("Customer", "Guest")),
      { judge: new RulesJudge() },
    );
    const draft = outcome.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "widen"),
    );
    expect(draft?.change.ops).toEqual([
      { op: "widen", path: "/owner", variant: "#/components/schemas/Guest", show: "id" },
    ]);
    expect(draft?.notes.join()).toMatch(/declared loss/);
  });

  it("leaves the new kind out of a list, where the union is a list's items", async () => {
    // Stripe's `discounts` is a list of a union: an item old callers cannot
    // read can be left out of the list, though no item may be null.
    const listed = (...variants: string[]) => ({
      ...withUnion("Customer"),
      Thing: object(
        {
          id: { type: "string" },
          owners: {
            type: "array",
            items: {
              anyOf: variants.map((name) => ({ $ref: `#/components/schemas/${name}` })),
            },
          },
        },
        ["id", "owners"],
      ),
    });
    const outcome = await propose(
      contract(listed("Customer")),
      contract(listed("Customer", "Guest")),
      { judge: new RulesJudge() },
    );
    const draft = outcome.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "widen"),
    );
    expect(draft?.change.ops).toEqual([
      {
        op: "widen",
        path: "/owners/*",
        variant: "#/components/schemas/Guest",
        show: "absent",
      },
    ]);
    expect(draft?.notes.join()).toMatch(/left out of the list/);
    expect(outcome.unresolved.map((entry) => entry.reason).join()).not.toMatch(/owners/);
  });

  it("leaves a request union that accepts more alone", async () => {
    const request = (...variants: string[]) => ({
      ...withUnion("Customer"),
      ThingCreate: object({ name: { type: "string" }, owner: expandable(...variants) }),
    });
    const outcome = await propose(
      contract(request("Customer")),
      contract(request("Customer", "Guest")),
      { judge: new RulesJudge() },
    );
    expect(
      outcome.proposals.some((proposal) =>
        proposal.change.ops.some((op) => op.op === "widen"),
      ),
    ).toBe(false);
  });
});

describe("a bound on a value that moved", () => {
  const withBody = (response: Schema, request: Schema) => ({
    ...base,
    Thing: object({ id: { type: "string" }, body: response }, ["id"]),
    ThingCreate: object({ name: { type: "string" }, body: request }),
  });

  it("is drafted as a relax where a response may now carry more", async () => {
    const outcome = await propose(
      contract(withBody({ type: "string", maxLength: 160 }, { type: "string" })),
      contract(withBody({ type: "string", maxLength: 1600 }, { type: "string" })),
      { judge: new RulesJudge() },
    );
    const draft = outcome.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "relax"),
    );
    expect(draft?.change.ops).toEqual([
      { op: "relax", path: "/body", set: { maxLength: 1600 } },
    ]);
  });

  it("is reported, never drafted, where old callers would be refused", async () => {
    const outcome = await propose(
      contract(withBody({ type: "string" }, { type: "string", maxLength: 1600 })),
      contract(withBody({ type: "string" }, { type: "string", maxLength: 160 })),
      { judge: new RulesJudge() },
    );
    expect(
      outcome.proposals.some((proposal) =>
        proposal.change.ops.some((op) => op.op === "relax"),
      ),
    ).toBe(false);
    expect(outcome.unresolved.map((entry) => entry.reason).join()).toMatch(/refused/);
  });

  it("is restated where a format appeared that the bounds already kept (Discord)", async () => {
    // Discord stated `int32` on a thread's slow mode, which it had always
    // bounded to 0 and 21600, on a schema old callers send and are sent.
    const slowMode = { type: "integer", minimum: 0, maximum: 21600 };
    const both = (field: Schema) => ({
      ...base,
      Shared: object({ id: { type: "string" }, rate_limit_per_user: field }, ["id"]),
      ThingCreate: { $ref: "#/components/schemas/Shared" },
    });
    const outcome = await propose(
      contract(both(slowMode)),
      contract(both({ ...slowMode, format: "int32" })),
      { judge: new RulesJudge() },
    );
    const ops = outcome.proposals.flatMap((proposal) => proposal.change.ops);
    expect(ops).toContainEqual({ op: "restate", path: "/rate_limit_per_user" });
    expect(ops.every((op) => op.op === "restate")).toBe(true);
    expect(outcome.unresolved).toEqual([]);
  });

  it("is still reported where the format may refuse what old callers send", async () => {
    const outcome = await propose(
      contract(withBody({ type: "string" }, { type: "integer" })),
      contract(withBody({ type: "string" }, { type: "integer", format: "int64" })),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals.flatMap((proposal) => proposal.change.ops)).toEqual([]);
    expect(outcome.unresolved.map((entry) => entry.reason).join()).toContain(
      "now allows less (format) in requests",
    );
  });
});

describe("a value written another way", () => {
  const thing = (fields: Record<string, Schema>) => ({
    ...base,
    Thing: object({ id: { type: "string" }, ...fields }, ["id"]),
  });
  const opsOf = async (before: Record<string, Schema>, after: Record<string, Schema>) => {
    const outcome = await propose(contract(thing(before)), contract(thing(after)), {
      judge: new RulesJudge(),
    });
    return outcome.proposals.flatMap((proposal) => proposal.change.ops);
  };

  it("drafts a count of seconds that became date-time text", async () => {
    expect(
      await opsOf(
        { created: { type: "integer" } },
        { created: { type: "string", format: "date-time" } },
      ),
    ).toContainEqual({
      op: "convert",
      path: "/created",
      codec: { kind: "dateFormat", from: "epoch-s", to: "rfc3339" },
    });
  });

  it("reads milliseconds where the field says so", async () => {
    expect(
      await opsOf(
        { expires_at: { type: "string", format: "date-time" } },
        {
          expires_at: {
            type: "integer",
            description: "Milliseconds since the Unix epoch.",
          },
        },
      ),
    ).toContainEqual({
      op: "convert",
      path: "/expires_at",
      codec: { kind: "dateFormat", from: "rfc3339", to: "epoch-ms" },
    });
  });

  it("drafts a value that became a list of what it was, and back", async () => {
    expect(
      await opsOf(
        { email: { type: "string" } },
        { email: { type: "array", items: { type: "string" } } },
      ),
    ).toContainEqual({ op: "convert", path: "/email", codec: { kind: "wrapArray" } });
    expect(
      await opsOf(
        { email: { type: "array", items: { type: "string" } } },
        { email: { type: "string" } },
      ),
    ).toContainEqual({ op: "convert", path: "/email", codec: { kind: "unwrapSingle" } });
  });

  it("does not call a list of something else a list of the value", async () => {
    const ops = await opsOf(
      { email: { type: "string" } },
      { email: { type: "array", items: { type: "integer" } } },
    );
    expect(ops.some((op) => op.op === "convert")).toBe(false);
  });

  it("drafts a vocabulary rewritten in another case", async () => {
    expect(
      await opsOf(
        { status: { type: "string", enum: ["in_progress", "past_due", "done"] } },
        { status: { type: "string", enum: ["IN_PROGRESS", "PAST_DUE", "DONE"] } },
      ),
    ).toContainEqual({
      op: "convert",
      path: "/status",
      codec: { kind: "stringCase", from: "snake", to: "screaming" },
    });
  });

  it("leaves a duration that changed unit to the scale, not the clock", async () => {
    const ops = await opsOf(
      { timeout_ms: { type: "integer" } },
      { timeout_ms: { type: "string", format: "duration" } },
    );
    expect(ops.some((op) => op.op === "convert" && op.codec.kind === "dateFormat")).toBe(
      false,
    );
  });
});

describe("bounds that moved both ways in one release", () => {
  it("declares the widening a response can carry and reports the narrowing a request cannot", async () => {
    // PayPal's shape: one schema used both ways, a limit raised and a
    // pattern added to the same field in the same release.
    const both = (field: Schema) => ({
      ...base,
      Shared: object({ id: { type: "string" }, note: field }, ["id"]),
      ThingCreate: { $ref: "#/components/schemas/Shared" },
    });
    const outcome = await propose(
      contract(both({ type: "string", maxLength: 127 })),
      contract(both({ type: "string", maxLength: 255, pattern: "^[^<>]*$" })),
      { judge: new RulesJudge() },
    );
    const relaxed = outcome.proposals
      .flatMap((proposal) => proposal.change.ops)
      .filter((op) => op.op === "relax");
    expect(relaxed).toEqual([{ op: "relax", path: "/note", set: { maxLength: 255 } }]);
    expect(outcome.unresolved.map((entry) => entry.reason).join()).toContain(
      "now allows less (pattern) in requests",
    );
  });
});

describe("how sure a judge has to be", () => {
  /** Answers every question with the first candidate, as one judge, at one confidence. */
  const sure = (judge: "jev" | "s2", confidence: number): Judge => ({
    id: judge,
    fingerprint: `stub:${judge}:${confidence}`,
    align: (questions) =>
      Promise.resolve(
        questions.map((question) => ({
          answer: {
            successor: question.candidates[0]?.name ?? null,
            confidence,
            scores: {},
            stated: false,
            abstained: false,
          },
          judge,
          model: undefined,
          latencyMs: 0,
          inputTokens: 0,
          costUsd: 0,
        })),
      ),
  });
  const renamed = async (judge: Judge) =>
    propose(
      contract(base),
      contract({
        ...base,
        Thing: object({ identifier: { type: "string" } }, ["identifier"]),
      }),
      { judge },
    );

  it("is measured per judge: the same answer drafts from one and is asked from another", async () => {
    const fromJev = await renamed(sure("jev", 0.7));
    expect(
      fromJev.proposals.some((p) => p.change.ops.some((op) => op.op === "move")),
    ).toBe(true);
    const fromS2 = await renamed(sure("s2", 0.7));
    expect(
      fromS2.proposals.some((p) => p.change.ops.some((op) => op.op === "move")),
    ).toBe(false);
    expect(fromS2.unresolved.map((entry) => entry.reason).join()).toMatch(
      /below the threshold/,
    );
  });
});

describe("a vocabulary that grew on a response", () => {
  // Figma's `ConnectorLineType` gained `CURVED`: a string enum of its own,
  // referenced from the field. It was asked about as a fold and reported as
  // inexpressible besides, which counted one change twice.
  const lineType = (values: string[]) => ({
    Thing: object(
      { id: { type: "string" }, line: { $ref: "#/components/schemas/Line" } },
      ["id", "line"],
    ),
    Line: { type: "string", enum: values },
  });
  const grown = async (before: string[], after: string[]) =>
    propose(
      contract({ ...base, ...lineType(before) }),
      contract({ ...base, ...lineType(after) }),
      {
        judge: new RulesJudge(),
      },
    );

  it("is one decision, not also a failure", async () => {
    const outcome = await grown(
      ["STRAIGHT", "ELBOWED"],
      ["STRAIGHT", "ELBOWED", "CURVED"],
    );
    expect(outcome.unresolved).toEqual([]);
    // Asked once, of the named schema, which answers for every use of it.
    expect(outcome.decisions).toEqual([
      expect.objectContaining({
        kind: "vocabulary",
        schema: "Line",
        pointer: "",
        gained: ["CURVED"],
      }),
    ]);
  });

  it("is nothing at all when only the order of its values changed", async () => {
    const outcome = await grown(["STRAIGHT", "ELBOWED"], ["ELBOWED", "STRAIGHT"]);
    expect(outcome.unresolved).toEqual([]);
    expect(outcome.decisions).toEqual([]);
    expect(outcome.proposals).toEqual([]);
  });
});

describe("a list of named values", () => {
  // Stripe's `payment_method_types`: a list whose items are an inline enum.
  // Its gained `satispay` reached thousands of places and was asked nowhere.
  const withTypes = (values: string[]) => ({
    ...base,
    Thing: object(
      {
        id: { type: "string" },
        payment_method_types: { type: "array", items: { type: "string", enum: values } },
      },
      ["id"],
    ),
  });

  it("is a vocabulary of its items, asked about when it gains a value", async () => {
    const outcome = await propose(
      contract(withTypes(["card", "sepa_debit"])),
      contract(withTypes(["card", "sepa_debit", "satispay"])),
      { judge: new RulesJudge() },
    );
    expect(outcome.unresolved).toEqual([]);
    expect(outcome.decisions).toEqual([
      expect.objectContaining({
        kind: "vocabulary",
        schema: "Thing",
        pointer: "/payment_method_types/*",
        gained: ["satispay"],
      }),
    ]);
  });

  it("is a declared loss when its items only lost a value", async () => {
    const outcome = await propose(
      contract(withTypes(["card", "sepa_debit", "giropay"])),
      contract(withTypes(["card", "sepa_debit"])),
      { judge: new RulesJudge() },
    );
    const draft = outcome.proposals.find((p) =>
      p.change.ops.some((op) => op.op === "relax"),
    );
    expect(draft?.change.ops).toEqual([
      {
        op: "relax",
        path: "/payment_method_types/*",
        set: { enum: ["card", "sepa_debit"] },
      },
    ]);
  });
});

describe("a vocabulary that only lost values", () => {
  const withState = (values: string[], request = false) => ({
    ...base,
    Thing: object({ id: { type: "string" }, state: { type: "string", enum: values } }, [
      "id",
    ]),
    ...(request
      ? {
          ThingCreate: object({
            name: { type: "string" },
            state: { type: "string", enum: values },
          }),
        }
      : {}),
  });

  it("is a declared loss where only old callers are sent it, with no pairing guessed", async () => {
    const outcome = await propose(
      contract(withState(["enabled", "disabled", "deleted"])),
      contract(withState(["enabled", "disabled"])),
      { judge: new RulesJudge() },
    );
    const draft = outcome.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "relax"),
    );
    expect(draft?.change.ops).toEqual([
      { op: "relax", path: "/state", set: { enum: ["enabled", "disabled"] } },
    ]);
    expect(draft?.notes.join()).toMatch(/never `deleted` any more.*declared loss/);
    expect(draft?.notes.join()).not.toMatch(/Pair them up/);
  });

  it("is a declared loss when null is what went, from a nullable enum that listed it", async () => {
    // Supabase's `ApiKeyResponse.type`: OpenAPI 3.0 lists null in a nullable
    // enum, and a release stopped listing it.
    const typed = (values: (string | null)[]) => ({
      ...base,
      Thing: object(
        {
          id: { type: "string" },
          type: { type: "string", nullable: true, enum: values },
        },
        ["id"],
      ),
    });
    const outcome = await propose(
      contract(typed(["legacy", "secret", null])),
      contract(typed(["legacy", "secret"])),
      { judge: new RulesJudge() },
    );
    expect(outcome.unresolved).toEqual([]);
    const draft = outcome.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "relax"),
    );
    expect(draft?.change.ops).toEqual([
      { op: "relax", path: "/type", set: { enum: ["legacy", "secret"] } },
    ]);
    expect(draft?.notes.join()).toMatch(/never `null` any more.*declared loss/);
  });

  it("is left for a person when the enum still lists null, which `relax` cannot restate", async () => {
    const typed = (values: (string | null)[]) => ({
      ...base,
      Thing: object(
        {
          id: { type: "string" },
          type: { type: "string", nullable: true, enum: values },
        },
        ["id"],
      ),
    });
    const outcome = await propose(
      contract(typed(["legacy", "secret", null])),
      contract(typed(["legacy", null])),
      { judge: new RulesJudge() },
    );
    expect(
      outcome.proposals.some((proposal) =>
        proposal.change.ops.some((op) => op.op === "relax"),
      ),
    ).toBe(false);
    expect(outcome.unresolved.map((entry) => entry.field)).toContain("type");
  });

  it("is a decision where old callers send it, since they send the value that went", async () => {
    const outcome = await propose(
      contract(withState(["enabled", "deleted"], true)),
      contract(withState(["enabled"], true)),
      { judge: new RulesJudge() },
    );
    expect(
      outcome.proposals.some(
        (proposal) =>
          proposal.change.id.includes("thing_create") &&
          proposal.change.ops.some((op) => op.op === "relax"),
      ),
    ).toBe(false);
    // Which accepted value an old caller's `deleted` is sent as is asked, with
    // the answer left as the placeholder the gate refuses.
    const asked = outcome.decisions.filter(
      (decision) => decision.kind === "vocabulary" && decision.schema === "ThingCreate",
    );
    expect(asked.map((decision) => decisionChange(decision).ops)).toEqual([
      [
        {
          op: "convert",
          path: "/state",
          codec: {
            kind: "enumMap",
            pairs: [
              ["enabled", "enabled"],
              ["deleted", CHOOSE_ONE],
            ],
          },
        },
      ],
    ]);
    expect(outcome.unresolved.map((entry) => entry.field)).not.toContain("state");
  });

  it("leaves out of a list what its items no longer accept, where old callers send it", async () => {
    const tagged = (values: string[]) => ({
      ...base,
      ThingCreate: object({
        name: { type: "string" },
        tags: { type: "array", items: { type: "string", enum: values } },
      }),
    });
    const outcome = await propose(
      contract(tagged(["gift", "rush", "fragile"])),
      contract(tagged(["gift", "fragile"])),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals.flatMap((proposal) => proposal.change.ops)).toEqual([
      { op: "convert", path: "/tags", codec: { kind: "dropValues", values: ["rush"] } },
    ]);
  });

  it("is not read as any text where the old values were not text", async () => {
    // Plaid's `AssetRetirementIndicator`: a string field whose old enum was
    // `[true, false]`, now `Yes` or `No`. Both old values are gone.
    const indicator = (values: unknown[]) => ({
      ...base,
      Thing: object(
        { id: { type: "string" }, retired: { type: "string", enum: values } },
        ["id"],
      ),
    });
    const outcome = await propose(
      contract(indicator([true, false])),
      contract(indicator(["Yes", "No"])),
      { judge: new RulesJudge() },
    );
    expect(
      outcome.proposals.flatMap((proposal) => proposal.change.ops).map((op) => op.op),
    ).not.toContain("relax");
  });

  it("is nothing lost where a field that held any text now names its values", async () => {
    // PayPal's error `location` went from any string to body, path or query.
    const location = (schema: Schema) => ({
      ...base,
      Thing: object({ id: { type: "string" }, location: schema }, ["id"]),
    });
    const outcome = await propose(
      contract(location({ type: "string" })),
      contract(location({ type: "string", enum: ["body", "path", "query"] })),
      { judge: new RulesJudge() },
    );
    const draft = outcome.proposals.find((proposal) =>
      proposal.change.ops.some((op) => op.op === "relax"),
    );
    expect(draft?.change.ops).toEqual([
      { op: "relax", path: "/location", set: { enum: ["body", "path", "query"] } },
    ]);
    expect(draft?.notes.join()).toMatch(/text the old contract already allowed/);
    expect(outcome.unresolved).toEqual([]);
  });
});

describe("a list that became nullable through a union with null", () => {
  it("is the same list, so nothing about its items is drafted as removed (Mistral's tools)", async () => {
    const tools = (schema: Schema) => ({
      ...base,
      ThingCreate: object({ name: { type: "string" }, tools: schema }),
    });
    const list = {
      type: "array",
      items: object({ type: { type: "string" }, name: { type: "string" } }),
    };
    const outcome = await propose(
      contract(tools(list)),
      contract(tools({ anyOf: [list, { type: "null" }] })),
      { judge: new RulesJudge() },
    );
    expect(
      outcome.proposals
        .flatMap((proposal) => proposal.change.ops)
        .filter((op) => op.op === "remove"),
    ).toEqual([]);
  });
});

describe("a named schema that became nullable through a union with null", () => {
  it("is the same field, now optional and nullable, as schemars writes Option<T> (Qdrant's telemetry)", async () => {
    // Qdrant 1.17 turned `app: AppBuildTelemetry` into `anyOf: [ref,
    // {nullable: true}]` and stopped requiring it. Read as a union, it was
    // reported as a change of shape no op expresses.
    const app = (schema: Schema, required: string[]) => ({
      ...base,
      App: object({ name: { type: "string" } }, ["name"]),
      Thing: object({ id: { type: "string" }, app: schema }, ["id", ...required]),
    });
    const ref = { $ref: "#/components/schemas/App" };
    const outcome = await propose(
      contract(app(ref, ["app"])),
      contract(app({ anyOf: [ref, { nullable: true }] }, [])),
      { judge: new RulesJudge() },
    );
    expect(outcome.unresolved).toEqual([]);
    expect(outcome.decisions.map((decision) => decisionChange(decision).id)).toEqual([
      "chg_thing_app_default_old",
    ]);
  });
});

describe("a named choice beside null", () => {
  it("is compared under its own name, not again at every field holding it (Qdrant's stemmer)", async () => {
    // Qdrant's `stemmer` is a named choice of stemming algorithms, or null.
    // Read through the choice, the field took on its branches, and the one
    // the choice gained was drafted again at the field, over what the
    // choice's own comparison said.
    const stemmer = (branches: Schema[]) => ({
      ...base,
      Snowball: object({ language: { type: "string" } }, ["language"]),
      Disabled: object({ type: { type: "string", enum: ["none"] } }, ["type"]),
      Stemming: { anyOf: branches },
      Thing: object(
        {
          id: { type: "string" },
          stemmer: {
            anyOf: [{ $ref: "#/components/schemas/Stemming" }, { nullable: true }],
          },
        },
        ["id"],
      ),
    });
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    const outcome = await propose(
      contract(stemmer([ref("Snowball")])),
      contract(stemmer([ref("Snowball"), ref("Disabled")])),
      { judge: new RulesJudge() },
    );
    expect(
      outcome.proposals.filter((proposal) =>
        proposal.change.ops.some((op) => "path" in op && op.path === "/stemmer"),
      ),
    ).toEqual([]);
  });
});

describe("a named object that became a list", () => {
  it("is a reshaping to write by hand, not its fields dropped (Meilisearch's AttributePatterns)", async () => {
    // Meilisearch 1.54 documents `AttributePatterns` as the list of strings
    // it always was on the wire, where 1.53 documented an object holding
    // one. Drafted as `patterns` removed from requests, closure called a
    // reshaping explained, and an old caller's patterns would have been
    // dropped wherever the object was really sent.
    const patterns = (schema: Schema) => ({
      ...base,
      Patterns: schema,
      ThingCreate: object({
        name: { type: "string" },
        facets: { $ref: "#/components/schemas/Patterns" },
      }),
    });
    const outcome = await propose(
      contract(
        patterns(
          object({ patterns: { type: "array", items: { type: "string" } } }, [
            "patterns",
          ]),
        ),
      ),
      contract(patterns({ type: "array", items: { type: "string" } })),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals.map((proposal) => proposal.change.ops)).toEqual([]);
    expect(
      outcome.unresolved.map((entry) => `${entry.schema}: ${entry.reason}`),
    ).toContain(
      "Patterns: the type changed from object to array, which no codec expresses. This is a reshaping rather than a re-encoding.",
    );
  });
});

describe("a list whose items became a choice", () => {
  // Asana's portfolio items, Twilio's compliance list and Langfuse's
  // evaluation-rule filters all did this between two versions: the items went
  // from one shape to a choice of shapes, or from a choice written out to a
  // choice with a name. Read as a field the list gained, each drafted an `add`
  // for `/<field>/*`, and the compiler refused every one of them, because a
  // list has no place of that name to copy a shape from.
  const withItems = (items: Schema) => ({
    ...base,
    Thing: object({ id: { type: "string" }, filters: { type: "array", items } }, ["id"]),
  });
  const branch = (kind: string) => object({ kind: { type: "string", enum: [kind] } });

  it("is not a field added or removed, whether the choice is named or written out", async () => {
    const pairs: [Schema, Schema][] = [
      // Written out on one side, named on the other.
      [branch("old"), { $ref: "#/components/schemas/Filters" }],
      // One shape, then a choice of shapes.
      [branch("old"), { oneOf: [branch("a"), branch("b")] }],
      // A choice of shapes, then one shape.
      [{ oneOf: [branch("a"), branch("b")] }, branch("only")],
    ];
    for (const [before, after] of pairs) {
      const outcome = await propose(
        contract(withItems(before)),
        contract({
          ...withItems(after),
          Filters: { oneOf: [branch("a"), branch("b")] },
        }),
        { judge: new RulesJudge() },
      );
      const ops = [
        ...outcome.proposals.map((proposal) => proposal.change),
        ...outcome.decisions.map(decisionChange),
      ].flatMap((change) => change.ops);
      expect(
        ops.filter((op) => "path" in op && String(op.path).endsWith("/*")),
        JSON.stringify(after),
      ).toEqual([]);
    }
  });
});

describe("fields that moved together through a wrapper", () => {
  const all = (outcome: Awaited<ReturnType<typeof propose>>) => [
    ...outcome.proposals.map((proposal) => proposal.change),
    ...outcome.decisions.map(decisionChange),
  ];
  const opsOn = (outcome: Awaited<ReturnType<typeof propose>>, path: string) =>
    all(outcome)
      .flatMap((change) => change.ops)
      .filter((op) => JSON.stringify(op).includes(`"${path}"`));

  it("is a move for each field when a wrapper was dissolved (Datadog)", async () => {
    // A JSON:API resource flattened: `type` and `attributes` gone, and what
    // `attributes` held now sits on the revision itself.
    const outcome = await propose(
      contract({
        ...base,
        Thing: object(
          {
            id: { type: "string" },
            revision: object({
              type: { type: "string", enum: ["custom_rule_revision"] },
              attributes: object({
                code: { type: "string" },
                name: { type: "string" },
                language: { type: "string" },
              }),
            }),
          },
          ["id"],
        ),
      }),
      contract({
        ...base,
        Thing: object(
          {
            id: { type: "string" },
            revision: object({
              code: { type: "string" },
              name: { type: "string" },
              language: { type: "string" },
            }),
          },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    const regrouped = outcome.proposals.find((proposal) =>
      proposal.change.id.endsWith("_hoisted"),
    );
    expect(regrouped?.change.ops).toEqual([
      { op: "move", from: "/revision/attributes/code", to: "/revision/code" },
      { op: "move", from: "/revision/attributes/name", to: "/revision/name" },
      { op: "move", from: "/revision/attributes/language", to: "/revision/language" },
    ]);
    // Nothing else acts on the fields that moved, or on the wrapper they left.
    for (const path of ["/revision/code", "/revision/name", "/revision/attributes"]) {
      expect(
        opsOn(outcome, path).filter((op) => op.op !== "move"),
        path,
      ).toEqual([]);
    }
  });

  it("asks what old callers are shown where a field that moved may now be missing (Datadog)", async () => {
    // The revision's attributes came up a level, and `cve`, always given to
    // old callers inside `attributes`, came up optional.
    const outcome = await propose(
      contract({
        ...base,
        Thing: object(
          {
            id: { type: "string" },
            revision: object({
              type: { type: "string", enum: ["custom_rule_revision"] },
              attributes: object({ code: { type: "string" }, cve: { type: "string" } }, [
                "code",
                "cve",
              ]),
            }),
          },
          ["id"],
        ),
      }),
      contract({
        ...base,
        Thing: object(
          {
            id: { type: "string" },
            revision: object({ code: { type: "string" }, cve: { type: "string" } }, [
              "code",
            ]),
          },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    expect(outcome.decisions).toEqual([
      expect.objectContaining({
        kind: "value",
        pointer: "/revision/cve",
        op: { op: "default", when: "absent", toward: "old" },
      }),
    ]);
  });

  it("reads a wrapper that is a named schema to find what moved through it (Datadog)", async () => {
    // As Datadog wrote it: the revision pointed at a resource schema whose
    // `attributes` is a schema of its own, and now points at one listing
    // those fields flat. Both old schemas are still there, unchanged.
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    const shared = {
      ...base,
      Revision: object({
        type: { type: "string", enum: ["custom_rule_revision"] },
        attributes: ref("RevisionAttributes"),
      }),
      RevisionAttributes: object({
        code: { type: "string" },
        name: { type: "string" },
        language: { type: "string" },
      }),
    };
    const outcome = await propose(
      contract({
        ...shared,
        Thing: object({ id: { type: "string" }, revision: ref("Revision") }, ["id"]),
      }),
      contract({
        ...shared,
        RevisionInput: object({
          code: { type: "string" },
          name: { type: "string" },
          language: { type: "string" },
        }),
        Thing: object({ id: { type: "string" }, revision: ref("RevisionInput") }, ["id"]),
      }),
      { judge: new RulesJudge() },
    );
    const regrouped = outcome.proposals.find((proposal) =>
      proposal.change.id.endsWith("_hoisted"),
    );
    expect(regrouped?.change.ops).toEqual([
      { op: "move", from: "/revision/attributes/code", to: "/revision/code" },
      { op: "move", from: "/revision/attributes/name", to: "/revision/name" },
      { op: "move", from: "/revision/attributes/language", to: "/revision/language" },
    ]);
    for (const path of ["/revision/code", "/revision/attributes"]) {
      expect(
        opsOn(outcome, path).filter((op) => op.op !== "move"),
        path,
      ).toEqual([]);
    }
  });

  it("is not a wrapper where the name now belongs to another schema (PayPal)", async () => {
    // The item a caller sent became the item a response reports, which holds
    // what was sent under `payout_item` beside what the service added.
    const sent = {
      amount: { type: "string" },
      receiver: { type: "string" },
      note: { type: "string" },
    };
    const outcome = await propose(
      contract({ ...base, Thing: object(sent) }),
      contract({
        ...base,
        Thing: object({
          payout_item_id: { type: "string" },
          transaction_status: { type: "string" },
          payout_item: object(sent),
        }),
      }),
      { judge: new RulesJudge() },
    );
    expect(
      outcome.proposals.filter((proposal) => proposal.change.id.endsWith("_nested")),
    ).toEqual([]);
  });

  it("is a move for each field when a wrapper was introduced", async () => {
    const outcome = await propose(
      contract({
        ...base,
        ThingCreate: object({
          amount: { type: "integer" },
          currency: { type: "string" },
          legacy: { type: "string" },
        }),
      }),
      contract({
        ...base,
        ThingCreate: object({
          price: object({ amount: { type: "integer" }, currency: { type: "string" } }),
          legacy: { type: "string" },
        }),
      }),
      { judge: new RulesJudge() },
    );
    const regrouped = outcome.proposals.find((proposal) =>
      proposal.change.id.endsWith("_nested"),
    );
    expect(regrouped?.change.ops).toEqual([
      { op: "move", from: "/amount", to: "/price/amount" },
      { op: "move", from: "/currency", to: "/price/currency" },
    ]);
  });

  it("is not read into one field that happens to share a name", async () => {
    // One field is a coincidence, not a restructure: left to the judge.
    const outcome = await propose(
      contract({
        ...base,
        Thing: object(
          { id: { type: "string" }, meta: object({ name: { type: "string" } }) },
          ["id"],
        ),
      }),
      contract({
        ...base,
        Thing: object({ id: { type: "string" }, name: { type: "string" } }, ["id"]),
      }),
      { judge: new RulesJudge() },
    );
    expect(
      outcome.proposals.filter((proposal) =>
        /_(hoisted|nested)$/.test(proposal.change.id),
      ),
    ).toEqual([]);
  });

  it("is not read where the wrapper is still there, or the type changed", async () => {
    const outcome = await propose(
      contract({
        ...base,
        Thing: object(
          {
            id: { type: "string" },
            outer: object({
              a: { type: "string" },
              b: { type: "string" },
              keep: { type: "string" },
            }),
            box: object({ c: { type: "string" }, d: { type: "string" } }),
          },
          ["id"],
        ),
      }),
      contract({
        ...base,
        Thing: object(
          {
            id: { type: "string" },
            // Still there, holding what stayed.
            outer: object({ keep: { type: "string" } }),
            a: { type: "string" },
            b: { type: "string" },
            // Gone, but what came out is not what went in.
            c: { type: "integer" },
            d: { type: "integer" },
          },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    expect(
      outcome.proposals.filter((proposal) =>
        /_(hoisted|nested)$/.test(proposal.change.id),
      ),
    ).toEqual([]);
  });
});

describe("restatements", () => {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const phone = (required: string[] = []) =>
    object(
      { country_code: { type: "string" }, national_number: { type: "string" } },
      required,
    );
  const restatementsIn = (outcome: Awaited<ReturnType<typeof propose>>) =>
    outcome.proposals.filter((proposal) => proposal.change.ops[0]?.op === "restate");

  it("is drafted where a field is stated another way and holds the same values", async () => {
    const outcome = await propose(
      contract({
        ...base,
        Phone: phone(),
        Thing: object({ id: { type: "string" }, phone: ref("Phone") }, ["id"]),
      }),
      contract({
        ...base,
        Phone: phone(),
        PhoneNumber: phone(),
        Thing: object(
          { id: { type: "string" }, phone: { allOf: [ref("PhoneNumber")] } },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    // The whole schema is proved, which is one statement for all of it.
    expect(restatementsIn(outcome).map((proposal) => proposal.change.ops)).toEqual([
      [{ op: "restate", path: "" }],
    ]);
  });

  it("is not drafted for a rename, which containment alone cannot tell apart (PayPal)", async () => {
    const problem = (name: string, choice: boolean) =>
      object({
        [name]: {
          type: "array",
          items: choice
            ? { anyOf: [object({ issue: { type: "string" } })] }
            : object({ issue: { type: "string" } }),
        },
      });
    const outcome = await propose(
      contract({ ...base, Thing: problem("issues", false) }),
      contract({ ...base, Thing: problem("details", true) }),
      { judge: new RulesJudge() },
    );
    expect(restatementsIn(outcome)).toEqual([]);
  });

  it("leaves what a referenced schema changed to its own draft (PayPal)", async () => {
    // The stored credential is restated as a choice, and the charge pattern
    // it refers to dropped its length bounds under its own name: the
    // restatement says nothing about the pattern, so the bounds keep theirs.
    const pattern = (bounded: boolean) => ({
      type: "string",
      enum: ["recurring", "unscheduled"],
      ...(bounded ? { minLength: 1, maxLength: 30 } : {}),
    });
    const credential = (choice: boolean) =>
      object({
        kind: choice
          ? {
              anyOf: [
                { type: "string", enum: ["a"] },
                { type: "string", enum: ["b"] },
              ],
            }
          : { type: "string", enum: ["a", "b"] },
        charge_pattern: ref("ChargePattern"),
      });
    const outcome = await propose(
      contract({ ...base, ChargePattern: pattern(true), Thing: credential(false) }),
      contract({ ...base, ChargePattern: pattern(false), Thing: credential(true) }),
      { judge: new RulesJudge() },
    );
    const ops = [
      ...outcome.proposals.map((proposal) => proposal.change),
      ...outcome.decisions.map(decisionChange),
    ].flatMap((change) => change.ops);
    // The whole credential would be written back as referring to the old
    // pattern, so the restatement is of the choice alone.
    expect(ops.filter((op) => op.op === "restate")).toEqual([
      { op: "restate", path: "/kind" },
    ]);
    expect(ops.filter((op) => op.op === "relax")).not.toEqual([]);
  });

  it("is not drafted where only a description beside a reference changed (Amazon)", async () => {
    const described = (description: string) =>
      object({
        threshold: { allOf: [ref("Threshold"), { description }] },
        description: { type: "string" },
      });
    const outcome = await propose(
      contract({
        ...base,
        Threshold: { type: "integer" },
        Thing: described("the old words"),
      }),
      contract({
        ...base,
        Threshold: { type: "integer" },
        Thing: described("new words"),
      }),
      { judge: new RulesJudge() },
    );
    expect(restatementsIn(outcome)).toEqual([]);
  });

  it("stands down where another draft changes a schema the place refers to (PayPal)", async () => {
    // The shared phone schema gained a required country code, which old
    // callers creating a thing must now be given one for; the thing's phone
    // restated as the old phone would be proved against a phone that draft
    // changes, and both cannot hold.
    const outcome = await propose(
      contract({
        ...base,
        Phone: phone(),
        Thing: object({ id: { type: "string" }, phone: ref("Phone") }, ["id"]),
        ThingCreate: object({ phone: ref("Phone") }),
      }),
      contract({
        ...base,
        Phone: phone(["country_code"]),
        PhoneNumber: phone(),
        Thing: object(
          { id: { type: "string" }, phone: { allOf: [ref("PhoneNumber")] } },
          ["id"],
        ),
        ThingCreate: object({ phone: ref("Phone") }),
      }),
      { judge: new RulesJudge() },
    );
    const others = [
      ...outcome.proposals.map((proposal) => proposal.change),
      ...outcome.decisions.map(decisionChange),
    ].filter((change) => JSON.stringify(change.scopes).includes('/Phone"'));
    expect(others.length).toBeGreaterThan(0);
    expect(restatementsIn(outcome)).toEqual([]);
  });
});

describe("a response vocabulary that opened, moved or grew from nothing", () => {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const connectors = { type: "string", enum: ["web_search", "code_interpreter"] };
  const opsOf = (outcome: Awaited<ReturnType<typeof propose>>) =>
    outcome.proposals.flatMap((proposal) => proposal.change.ops);

  // Mistral's tool `name` went from one of its built-in connectors to one of
  // them or any other name, which the differ read as values removed and a
  // union added.
  it("declares a choice of the values it named and any text as the vocabulary opening", async () => {
    const outcome = await propose(
      contract({
        ...base,
        Connectors: connectors,
        Thing: object({ id: { type: "string" }, name: ref("Connectors") }, ["id"]),
      }),
      contract({
        ...base,
        Connectors: connectors,
        Thing: object(
          {
            id: { type: "string" },
            name: { anyOf: [ref("Connectors"), { type: "string" }] },
          },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    expect(opsOf(outcome)).toEqual([
      { op: "relax", path: "/name", set: { enum: null } },
      { op: "restate", path: "/name" },
    ]);
    expect(outcome.unresolved).toEqual([]);
    expect(outcome.decisions).toEqual([]);
  });

  it("does not read a choice between kinds of text as any text", async () => {
    const outcome = await propose(
      contract({
        ...base,
        Connectors: connectors,
        Thing: object({ id: { type: "string" }, name: ref("Connectors") }, ["id"]),
      }),
      contract({
        ...base,
        Connectors: connectors,
        Thing: object(
          {
            id: { type: "string" },
            name: { anyOf: [ref("Connectors"), { type: "string", format: "uri" }] },
          },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    expect(opsOf(outcome)).not.toContainEqual(
      expect.objectContaining({ op: "relax", set: { enum: null } }),
    );
  });

  // Apicurio's `ArtifactType` named eleven kinds of artifact, then any text.
  it("declares a named vocabulary that stopped listing its values once, at the schema", async () => {
    const thing = object({ id: { type: "string" }, type: ref("ArtifactType") }, ["id"]);
    const outcome = await propose(
      contract({
        ...base,
        ArtifactType: { type: "string", enum: ["AVRO", "JSON"] },
        Thing: thing,
      }),
      contract({ ...base, ArtifactType: { type: "string" }, Thing: thing }),
      { judge: new RulesJudge() },
    );
    expect(outcome.proposals.map((proposal) => proposal.change)).toEqual([
      expect.objectContaining({
        scopes: [{ schema: "#/components/schemas/ArtifactType" }],
        ops: [{ op: "relax", path: "", set: { enum: null } }],
      }),
    ]);
    expect(outcome.unresolved).toEqual([]);
  });

  // Okta's custom role `type` listed `CUSTOM` alone, and came to refer to
  // `RoleType`, which names every role there is.
  it("asks about the values a field gained by referring to a named vocabulary", async () => {
    const roles = { type: "string", enum: ["CUSTOM", "ORG_ADMIN", "APP_ADMIN"] };
    const outcome = await propose(
      contract({
        ...base,
        RoleType: roles,
        Thing: object(
          { id: { type: "string" }, type: { type: "string", enum: ["CUSTOM"] } },
          ["id"],
        ),
      }),
      contract({
        ...base,
        RoleType: roles,
        Thing: object({ id: { type: "string" }, type: ref("RoleType") }, ["id"]),
      }),
      { judge: new RulesJudge() },
    );
    expect(outcome.decisions).toEqual([
      expect.objectContaining({
        kind: "vocabulary",
        schema: "Thing",
        pointer: "/type",
        gained: ["ORG_ADMIN", "APP_ADMIN"],
        choices: ["CUSTOM"],
      }),
    ]);
    expect(outcome.unresolved).toEqual([]);
  });

  it("leaves a field that stopped referring to a vocabulary that changed to that vocabulary's own Change", async () => {
    // Its own Change runs wherever the old contract used it, this field
    // included, so a second one here would translate the value twice.
    const outcome = await propose(
      contract({
        ...base,
        RuleType: { type: "string", enum: ["SIGN_ON", "RESOURCE_ACCESS", "OLD"] },
        Thing: object({ id: { type: "string" }, type: ref("RuleType") }, ["id"]),
      }),
      contract({
        ...base,
        RuleType: { type: "string", enum: ["SIGN_ON", "RESOURCE_ACCESS", "NEW"] },
        Thing: object(
          { id: { type: "string" }, type: { type: "string", enum: ["RESOURCE_ACCESS"] } },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    const places = [
      ...outcome.decisions.map((decision) => decision.schema),
      ...outcome.proposals.flatMap((proposal) =>
        (proposal.change.scopes ?? []).map((scope) => JSON.stringify(scope)),
      ),
    ];
    expect(places.join()).not.toMatch(/Thing/);
  });

  // Discord's `event_webhooks_types` listed no values beside `allOf` a schema
  // of every event there is, then twelve.
  const eventTypes = (values: string[]) => ({
    type: "array",
    uniqueItems: true,
    items: { type: "string", enum: values, allOf: [ref("ActionTypes")] },
  });
  const actionTypes = {
    type: "string",
    oneOf: [{ const: "ENTITLEMENT_CREATE" }, { const: "LOBBY_MESSAGE_CREATE" }],
  };

  it("leaves out of a response list the values it gained where it named none", async () => {
    const outcome = await propose(
      contract({
        ...base,
        ActionTypes: actionTypes,
        Thing: object({ id: { type: "string" }, events: eventTypes([]) }, ["id"]),
      }),
      contract({
        ...base,
        ActionTypes: actionTypes,
        Thing: object(
          {
            id: { type: "string" },
            events: eventTypes(["ENTITLEMENT_CREATE", "LOBBY_MESSAGE_CREATE"]),
          },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    expect(opsOf(outcome)).toEqual([
      {
        op: "convert",
        path: "/events",
        codec: {
          kind: "dropValues",
          values: ["ENTITLEMENT_CREATE", "LOBBY_MESSAGE_CREATE"],
        },
      },
    ]);
    expect(outcome.decisions).toEqual([]);
    expect(outcome.unresolved).toEqual([]);
  });

  // The same list, once it names values, holds each at most once. A value it
  // gains folded onto one it named would show old callers that value twice
  // wherever the list already held it, so the new value is left out instead.
  it("leaves out of a list that holds no value twice what it gained, rather than folding it", async () => {
    const outcome = await propose(
      contract({
        ...base,
        ActionTypes: actionTypes,
        Thing: object(
          { id: { type: "string" }, events: eventTypes(["ENTITLEMENT_CREATE"]) },
          ["id"],
        ),
      }),
      contract({
        ...base,
        ActionTypes: actionTypes,
        Thing: object(
          {
            id: { type: "string" },
            events: eventTypes(["ENTITLEMENT_CREATE", "LOBBY_MESSAGE_CREATE"]),
          },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    expect(opsOf(outcome)).toEqual([
      {
        op: "convert",
        path: "/events",
        codec: { kind: "dropValues", values: ["LOBBY_MESSAGE_CREATE"] },
      },
    ]);
    expect(outcome.decisions).toEqual([]);
    expect(outcome.unresolved).toEqual([]);
  });

  it("still asks which value a list that may repeat values shows a new one as", async () => {
    const { uniqueItems: _set, ...list } = eventTypes(["ENTITLEMENT_CREATE"]);
    const outcome = await propose(
      contract({
        ...base,
        ActionTypes: actionTypes,
        Thing: object({ id: { type: "string" }, events: list }, ["id"]),
      }),
      contract({
        ...base,
        ActionTypes: actionTypes,
        Thing: object(
          {
            id: { type: "string" },
            events: {
              ...list,
              items: {
                ...list.items,
                enum: ["ENTITLEMENT_CREATE", "LOBBY_MESSAGE_CREATE"],
              },
            },
          },
          ["id"],
        ),
      }),
      { judge: new RulesJudge() },
    );
    expect(opsOf(outcome)).toEqual([]);
    expect(outcome.decisions).toEqual([
      expect.objectContaining({
        kind: "vocabulary",
        pointer: "/events/*",
        gained: ["LOBBY_MESSAGE_CREATE"],
      }),
    ]);
  });

  // Okta's user schema attributes listed their enum's values as text, and a
  // later release as text or whole numbers: a value that became one of two
  // types still states its type, and is not declared as having none.
  it("declares a list's items that became a choice of types as those types, restated", async () => {
    const values = (items: Schema) =>
      object({ id: { type: "string" }, values: { type: "array", items } }, ["id"]);
    const outcome = await propose(
      contract({ ...base, Thing: values({ type: "string" }) }),
      contract({
        ...base,
        Thing: values({ anyOf: [{ type: "string" }, { type: "integer" }] }),
      }),
      { judge: new RulesJudge() },
    );
    expect(opsOf(outcome)).toEqual([
      { op: "relax", path: "/values/*", set: { type: ["string", "integer"] } },
      { op: "restate", path: "/values/*" },
    ]);
    expect(outcome.unresolved).toEqual([]);
  });

  it("asks nothing where only old callers send a list that gained values", async () => {
    const outcome = await propose(
      contract({
        ...base,
        ActionTypes: actionTypes,
        ThingCreate: object({ name: { type: "string" }, events: eventTypes([]) }),
      }),
      contract({
        ...base,
        ActionTypes: actionTypes,
        ThingCreate: object({
          name: { type: "string" },
          events: eventTypes(["ENTITLEMENT_CREATE"]),
        }),
      }),
      { judge: new RulesJudge() },
    );
    expect(opsOf(outcome)).toEqual([]);
    expect(outcome.unresolved).toEqual([]);
  });
});
