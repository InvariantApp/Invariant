/**
 * Rig E, what the engine is told on a Stripe upgrade: the Changes between the
 * two API versions the SDK releases speak, and what the SDK calls each schema.
 *
 * Each stripe-node release records the stripe/openapi release it was built
 * from (`OPENAPI_VERSION` at its tag), and that release holds the
 * specification of the API version it pins. The Changes are drafted by the
 * proposer from those two documents, with the rules judge alone, so nothing
 * here depends on a model: where no judge says what replaced a removed field,
 * the field is simply gone, a declared loss, and the engine sends a person to
 * every place the consumer still reads or writes it.
 *
 * What the old SDK calls each schema and which of its methods calls each
 * operation is the symbol map `@invariant-app/symbols` makes from the
 * release itself, as a migration run would: `subscription` is
 * `Stripe.Subscription` and `checkout.session` is `Stripe.Checkout.Session`
 * in stripe-node, `stripe.checkout.Session` in stripe-python. The engine
 * then finds each by its qualified name, or not at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type OpenApiDocument, readDocument } from "@invariant-app/contract";
import type { Change } from "@invariant-app/ir";
import type { WireOperation, WireTags } from "@invariant-app/migrate-core";
import type { GoSymbol, SurfaceObject } from "@invariant-app/migrate-go";
import { type Decision, propose, RulesJudge } from "@invariant-app/proposer";
import {
  cachedSymbols,
  type Declaration,
  directoryCache,
  goSymbolsOf,
  type Language,
  matchRelease,
  symbolMapOf,
} from "@invariant-app/symbols";
import { ROOT } from "../corpus/manifest.mts";
import { breakingBetween } from "./forced.mts";
import { type ClassFields, classFields } from "./stubs.mts";

export const SPECS = join(ROOT, ".cache/replay/specs");
const TAGS = join(SPECS, "stripe-openapi-tags.json");

/** Which of Stripe's SDKs a release number belongs to. */
export type StripeSdk = "stripe-node" | "stripe-python" | "stripe-go";

/**
 * The stripe/openapi release an SDK release was built from. stripe-python
 * records it the same way as stripe-node, at every tag since 2.x.
 */
async function openapiRelease(version: string, sdk: StripeSdk): Promise<string> {
  const known: Record<string, string> = existsSync(TAGS)
    ? (JSON.parse(readFileSync(TAGS, "utf8")) as Record<string, string>)
    : {};
  // stripe-node's releases were recorded first, under their bare numbers.
  const key = sdk === "stripe-node" ? version : `${sdk}@${version}`;
  const cached = known[key];
  if (cached) return cached;
  // stripe-go's versions are its module's, tagged as they are spelled.
  const tag = version.startsWith("v") ? version : `v${version}`;
  const response = await fetch(
    `https://raw.githubusercontent.com/stripe/${sdk}/${tag}/OPENAPI_VERSION`,
  );
  if (!response.ok) {
    throw new Error(`${sdk} ${version} records no OpenAPI release (${response.status})`);
  }
  const release = (await response.text()).trim();
  known[key] = release;
  await mkdir(SPECS, { recursive: true });
  await writeFile(TAGS, `${JSON.stringify(known, null, 2)}\n`);
  return release;
}

/** The specification a stripe/openapi release holds, as `v1505`. */
export async function specification(release: string): Promise<OpenApiDocument> {
  const path = join(SPECS, `stripe-${release}.json`);
  if (!existsSync(path)) {
    const response = await fetch(
      `https://raw.githubusercontent.com/stripe/openapi/${release}/openapi/spec3.json`,
    );
    if (!response.ok) throw new Error(`stripe/openapi ${release}: ${response.status}`);
    await mkdir(SPECS, { recursive: true });
    await writeFile(path, await response.text());
  }
  return readDocument(path);
}

/** The specification of the API version one of Stripe's SDK releases speaks. */
export async function stripeSpecification(
  version: string,
  sdk: StripeSdk,
): Promise<OpenApiDocument> {
  return specification(await openapiRelease(version, sdk));
}

/**
 * Symbol maps already made, per release and contract digest, so a case
 * replayed again, or a second case on the same upgrade, does not read the
 * release again.
 */
const SYMBOLS = directoryCache(join(ROOT, ".cache/replay/symbols"));

/**
 * What a release unpacked at `sdk` calls each of the contract's schemas and
 * which of its methods calls each operation, as `@invariant-app/symbols`
 * reads them from the release. `module` picks one top-level package out of
 * a `site-packages`.
 */
export async function releaseSymbols(
  sdk: string,
  language: Language,
  document: OpenApiDocument,
  module?: string,
): Promise<{
  types: Record<string, string>;
  operations: Record<string, { type: string; method: string }>;
}> {
  return symbolMapOf(
    await cachedSymbols(
      { sdk, language, contract: document, ...(module ? { module } : {}) },
      SYMBOLS,
    ),
  );
}

/**
 * What stripe-go calls each schema, from the old release's surface: each
 * struct of the module's root package with the wire names its fields' `json`
 * tags give, matched as `@invariant-app/symbols` matches any Go release. The
 * surface comes from the Go helper, through `go/types`, so the package's own
 * source reader is not needed here.
 */
export async function stripeGoSymbols(
  document: OpenApiDocument,
  surface: readonly SurfaceObject[],
): Promise<Record<string, GoSymbol>> {
  const fields = new Map<string, Set<string>>();
  for (const object of surface) {
    if (object.kind !== "field" || object.package !== "" || !object.json) continue;
    const [holder, field, ...rest] = object.key.split(".");
    if (!holder || !field || rest.length > 0) continue;
    fields.set(holder, (fields.get(holder) ?? new Set()).add(object.json));
  }
  const declarations: Declaration[] = [...fields].map(([name, wire]) => ({
    qualified: name,
    name,
    kind: "object",
    fields: [...wire],
    package: "",
    file: "",
  }));
  const matched = await matchRelease(
    { declarations, calls: [], generators: ["stripe"] },
    document,
    { language: "go" },
  );
  return goSymbolsOf(matched).types;
}

export interface ContractPlan {
  changes: Change[];
  /** The API as a plain HTTP client reaches it, from the old specification. */
  wire?: { servers: string[]; operations: WireOperation[] };
  /** stripe-python's classes and their fields, from the old specification. */
  classes?: ClassFields[];
  /**
   * How Stripe's objects name their schema, `"object": "invoice"`, read from
   * both specifications, and the API version the upgraded SDK speaks.
   */
  tags: WireTags;
  /** Schema name to the old SDK's type for it. */
  types: Record<string, string>;
  /** Each operation to the SDK method that calls it. */
  operations: Record<string, { type: string; method: string }>;
  /** Drafts, and removals no judge could pair, for the record. */
  drafted: number;
  removed: number;
  /** The names the upgrade broke (`forced.mts`), where the differ could say. */
  breaking?: string[] | undefined;
}

/** The one schema a property refers to, directly or as the only non-null choice. */
function refOf(property: unknown): string | undefined {
  if (typeof property !== "object" || property === null) return undefined;
  const value = property as { $ref?: string; anyOf?: unknown[]; allOf?: unknown[] };
  if (value.$ref?.startsWith("#/components/schemas/")) {
    return value.$ref.slice("#/components/schemas/".length);
  }
  const choices = (value.anyOf ?? value.allOf ?? [])
    .map(refOf)
    .filter((ref) => ref !== undefined);
  return choices.length === 1 ? choices[0] : undefined;
}

type Schemas = Record<string, { properties?: Record<string, unknown> }>;

export const schemasOf = (document: OpenApiDocument): Schemas =>
  ((
    (document as Record<string, unknown>)["components"] as
      | { schemas?: Schemas }
      | undefined
  )?.schemas ?? {}) as Schemas;

/**
 * Each schema's tag, from the one value its `object` property may take, in
 * either specification, and the version the newer one describes.
 */
export function wireTags(before: OpenApiDocument, after: OpenApiDocument): WireTags {
  // Several schemas can carry one tag: `deleted_invoice` is tagged `invoice`
  // too. The schema named as its tag is the one it names; a tag no schema is
  // named after, shared by more than one, names none of them.
  const candidates = new Map<string, Set<string>>();
  for (const document of [before, after]) {
    for (const [name, schema] of Object.entries(schemasOf(document))) {
      const tag = schema.properties?.["object"] as { enum?: unknown[] } | undefined;
      const value = tag?.enum?.length === 1 ? tag.enum[0] : undefined;
      if (typeof value !== "string") continue;
      candidates.set(value, (candidates.get(value) ?? new Set()).add(name));
    }
  }
  const schemas: Record<string, string> = {};
  for (const [value, names] of candidates) {
    if (names.has(value)) schemas[value] = value;
    else if (names.size === 1) schemas[value] = [...names][0] as string;
  }
  const versionOf = (document: OpenApiDocument) =>
    (document as { info?: { version?: string } }).info?.version;
  const from = versionOf(before);
  const label = versionOf(after);
  return {
    property: "object",
    schemas,
    ...(from && label && schemas["event"]
      ? { version: { schema: "event", property: "api_version", from, label } }
      : {}),
  };
}

/**
 * Each operation of a specification as a URL reaches it, with the schema its
 * success response is, where it names one.
 */
export function wireOf(document: OpenApiDocument): {
  servers: string[];
  operations: WireOperation[];
} {
  const spec = document as {
    servers?: { url?: string }[];
    paths?: Record<string, Record<string, unknown>>;
  };
  const operations: WireOperation[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, value] of Object.entries(item ?? {})) {
      const operation = value as {
        operationId?: string;
        responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
      };
      if (!operation?.operationId) continue;
      const success = operation.responses?.["200"] ?? operation.responses?.["201"];
      const response = refOf(success?.content?.["application/json"]?.schema);
      operations.push({
        id: operation.operationId,
        method: method.toLowerCase(),
        path,
        ...(response ? { response } : {}),
      });
    }
  }
  return {
    servers: (spec.servers ?? []).flatMap((server) => (server.url ? [server.url] : [])),
    operations,
  };
}

/**
 * The removals the proposer left as decisions, as Changes. A field a response
 * always carried and no longer does is left to the provider to decide what
 * old callers are given instead: a decision, not a draft. For a consumer the
 * field is gone all the same. basil's `subscription.current_period_end` is
 * one; read only from the drafts and the unpaired removals, hiroppy's
 * web-app-template replayed as though it were still there.
 */
export function decidedRemovals(
  decisions: readonly Decision[],
  drafted: readonly Change[],
): Change[] {
  const scoped = (scopes: unknown, path: string) => `${JSON.stringify(scopes)}${path}`;
  const known = new Set(
    drafted.flatMap((change) =>
      change.ops.flatMap((op) =>
        op.op === "remove" ? [scoped(change.scopes, op.path)] : [],
      ),
    ),
  );
  return decisions.flatMap((decision): Change[] => {
    if (decision.kind !== "value" || decision.op.op !== "remove") return [];
    const scopes = [
      decision.scope ?? { schema: `#/components/schemas/${decision.schema}` },
    ];
    if (known.has(scoped(scopes, decision.pointer))) return [];
    return [
      {
        irVersion: 1,
        id: decision.id,
        summary: `${decision.summary} ${decision.why}`,
        scopes,
        ops: [{ op: "remove", path: decision.pointer, restore: null }],
      },
    ];
  });
}

/** The Changes the rules judge drafts between two releases' specifications, and the removals it could not pair. */
async function changesBetween(
  from: string,
  to: string,
  flavour: StripeSdk,
): Promise<{
  before: OpenApiDocument;
  after: OpenApiDocument;
  changes: Change[];
  drafted: number;
  removed: number;
  breaking: string[] | undefined;
}> {
  // One after the other: each records what it found in the same file.
  const oldRelease = await openapiRelease(from, flavour);
  const newRelease = await openapiRelease(to, flavour);
  const [before, after] = await Promise.all([
    specification(oldRelease),
    specification(newRelease),
  ]);
  return {
    before,
    after,
    ...(await draftChanges(before, after)),
    breaking: await breakingBetween(
      before,
      after,
      join(SPECS, "breaking", `stripe-${oldRelease}-${newRelease}.json`),
    ),
  };
}

/**
 * What a provider's release would publish between two specifications, drafted
 * with the rules judge alone: the proposals, a removal for each field no judge
 * paired, and the removals a decision names.
 */
export async function draftChanges(
  before: OpenApiDocument,
  after: OpenApiDocument,
): Promise<{ changes: Change[]; drafted: number; removed: number }> {
  const outcome = await propose(before, after, { judge: new RulesJudge() });
  const removals: Change[] = outcome.unresolved
    .filter((entry) => entry.side === "removed")
    .map((entry) => ({
      irVersion: 1,
      id: `chg_gone_${entry.schema}_${entry.field}`.replace(/[^\w]/g, "_").slice(0, 120),
      summary: `\`${entry.field}\` is no longer in \`${entry.schema}\`; ${entry.reason}.`,
      scopes: [{ schema: `#/components/schemas/${entry.schema}` }],
      // A nested field is named with dots, as `recurring.aggregate_usage`.
      ops: [
        { op: "remove", path: `/${entry.field.split(".").join("/")}`, restore: null },
      ],
    }));
  const decided = decidedRemovals(outcome.decisions, [
    ...outcome.proposals.map((proposal) => proposal.change),
    ...removals,
  ]);
  return {
    changes: [
      ...outcome.proposals.map((proposal) => proposal.change),
      ...removals,
      ...decided,
    ],
    drafted: outcome.proposals.length,
    removed: removals.length + decided.length,
  };
}

/**
 * The Changes, tags and types for an upgrade of stripe-go, whose types are
 * read from the old release's surface (`stripeGoSymbols`): a schema is the
 * type its name spells in the module's root package (`checkout.session` is
 * `CheckoutSession`), unless the fields say otherwise, since stripe-go's
 * `LineItem` is a checkout session's item and an invoice's is
 * `InvoiceLineItem`.
 */
export async function stripeGoPlan(
  from: string,
  to: string,
  surface: readonly SurfaceObject[],
): Promise<{
  changes: Change[];
  types: Record<string, GoSymbol>;
  tags: WireTags;
  breaking: string[] | undefined;
}> {
  const { before, after, changes, breaking } = await changesBetween(
    from,
    to,
    "stripe-go",
  );
  const types = await stripeGoSymbols(before, surface);
  return { changes, types, tags: wireTags(before, after), breaking };
}

/**
 * The Changes and types for an upgrade from `from` to `to` of stripe-node, or
 * of stripe-python, whose `sdk` is the unpacked wheel's `site-packages`.
 */
export async function stripePlan(
  from: string,
  to: string,
  sdk: string,
  flavour: StripeSdk = "stripe-node",
): Promise<ContractPlan> {
  const { before, changes, drafted, removed, after, breaking } = await changesBetween(
    from,
    to,
    flavour,
  );
  const tags = wireTags(before, after);
  const python = flavour === "stripe-python";
  const { types, operations } = await releaseSymbols(
    sdk,
    python ? "python" : "typescript",
    before,
    python ? "stripe" : undefined,
  );
  return {
    changes,
    tags,
    types,
    operations,
    // What each class holds, for a release that ships no types (`stubs.mts`),
    // and the API as a plain HTTP client reaches it.
    ...(python ? { classes: classFields(before, types), wire: wireOf(before) } : {}),
    drafted,
    removed,
    breaking,
  };
}
