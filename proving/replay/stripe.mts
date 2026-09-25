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
 * The schemas' types are read from the old SDK's own declarations, the
 * simplest form of the symbol map M6.1 generates: `subscription` is
 * `Stripe.Subscription` and `checkout.session` is `Stripe.Checkout.Session`,
 * where the release declares that interface; the engine then finds each by
 * its qualified name, or not at all.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type OpenApiDocument, readDocument } from "@invariant-app/contract";
import type { Change } from "@invariant-app/ir";
import type { WireOperation, WireTags } from "@invariant-app/migrate-core";
import type { GoSymbol, SurfaceObject } from "@invariant-app/migrate-go";
import { type Decision, propose, RulesJudge } from "@invariant-app/proposer";
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

async function specification(release: string): Promise<OpenApiDocument> {
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

const pascal = (name: string) =>
  name
    .split("_")
    .filter(Boolean)
    .map((part) => (part[0] ?? "").toUpperCase() + part.slice(1))
    .join("");

/**
 * What stripe-node calls a schema's type: each dot is a namespace, so
 * `checkout.session` is `Checkout.Session` and `payment_intent` is
 * `PaymentIntent`.
 */
const typeNameOf = (schema: string) => schema.split(".").map(pascal).join(".");

/** Every interface an SDK's declarations name, by its bare name. */
function declaredInterfaces(
  dir: string,
  found = new Set<string>(),
  depth = 0,
): Set<string> {
  if (depth > 4) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      declaredInterfaces(path, found, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      for (const match of readFileSync(path, "utf8").matchAll(/\binterface (\w+)/g)) {
        found.add(match[1] as string);
      }
    }
  }
  return found;
}

/**
 * The SDK method that calls each operation, read from stripe-node's own
 * resource files as data: `retrieveUpcoming: stripeMethod({ method: 'GET',
 * fullPath: '/v1/invoices/upcoming' })` in `resources/Invoices.js` is
 * `Stripe.InvoicesResource.retrieveUpcoming`, and one in
 * `resources/Checkout/Sessions.js` is on `Stripe.Checkout.SessionsResource`.
 */
function operationsOf(
  sdk: string,
  namespaced: boolean,
): Record<string, { type: string; method: string }> {
  const operations: Record<string, { type: string; method: string }> = {};
  const root = ["cjs/resources", "lib/resources", "esm/resources"]
    .map((dir) => join(sdk, dir))
    .find((dir) => existsSync(dir));
  if (!root) return operations;
  const walk = (dir: string, namespaces: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), [...namespaces, entry.name]);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const resource = `${entry.name.slice(0, -3)}Resource`;
      const type = [...(namespaced ? ["Stripe"] : []), ...namespaces, resource].join(".");
      const text = readFileSync(join(dir, entry.name), "utf8");
      const pattern =
        /(\w+):\s*stripeMethod\(\{\s*method:\s*'(\w+)',\s*fullPath:\s*'([^']+)'/g;
      for (const match of text.matchAll(pattern)) {
        const key = `${(match[2] as string).toLowerCase()} ${match[3] as string}`;
        operations[key] ??= { type, method: match[1] as string };
      }
    }
  };
  walk(root, []);
  return operations;
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

/**
 * Every class a stripe-python release declares, by its name: at the top of a
 * module, as `Subscription` in `stripe/_subscription.py`, and nested in
 * another, as `AutomaticTax` inside it.
 */
function declaredClasses(
  dir: string,
  found = { top: new Set<string>(), nested: new Set<string>() },
  depth = 0,
): { top: Set<string>; nested: Set<string> } {
  if (depth > 4) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) declaredClasses(path, found, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".py")) {
      for (const match of readFileSync(path, "utf8").matchAll(/^( *)class (\w+)\b/gm)) {
        (match[1] === "" ? found.top : found.nested).add(match[2] as string);
      }
    }
  }
  return found;
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

/**
 * What stripe-python calls a schema's class: namespaces are modules and keep
 * their names, so `checkout.session` is `stripe.checkout.Session` and
 * `subscription_item` is `stripe.SubscriptionItem`.
 */
const pythonTypeOf = (schema: string) => {
  const parts = schema.split(".");
  return ["stripe", ...parts.slice(0, -1), pascal(parts.at(-1) ?? "")].join(".");
};

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
 * read from the old release's surface: a schema is the type its name spells
 * in the module's root package (`checkout.session` is `CheckoutSession`)
 * only where that type's wire names are the schema's, since stripe-go's
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
  const fields = new Map<string, Set<string>>();
  for (const object of surface) {
    if (object.kind !== "field" || object.package !== "" || !object.json) continue;
    const holder = object.key.split(".")[0] as string;
    if (object.key.split(".").length !== 2) continue;
    fields.set(holder, (fields.get(holder) ?? new Set()).add(object.json));
  }
  const types: Record<string, GoSymbol> = {};
  for (const [schema, definition] of Object.entries(schemasOf(before))) {
    const name = schema.split(".").map(pascal).join("");
    const declared = fields.get(name);
    const properties = Object.keys(definition.properties ?? {});
    if (!declared || properties.length === 0) continue;
    const shared = properties.filter((property) => declared.has(property)).length;
    if (shared / new Set([...properties, ...declared]).size >= 0.8) {
      types[schema] = { package: "", key: name };
    }
  }
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
  namespaced: boolean,
  flavour: StripeSdk = "stripe-node",
): Promise<ContractPlan> {
  const { before, changes, drafted, removed, after, breaking } = await changesBetween(
    from,
    to,
    flavour,
  );
  const tags = wireTags(before, after);
  const schemas = Object.keys(
    (
      (before as Record<string, unknown>)["components"] as
        | { schemas?: object }
        | undefined
    )?.schemas ?? {},
  );
  const types: Record<string, string> = {};
  if (flavour === "stripe-python") {
    const classes = declaredClasses(join(sdk, "stripe"));
    for (const schema of schemas) {
      const name = pythonTypeOf(schema);
      if (classes.top.has(name.split(".").at(-1) ?? name)) types[schema] = name;
    }
    // A schema only one object holds is a class nested in that object's:
    // `subscription_automatic_tax` is `stripe.Subscription.AutomaticTax`,
    // named after the property, found through the property that refers to
    // it, as deep as the nesting goes.
    const components = (
      (before as Record<string, unknown>)["components"] as {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      }
    ).schemas;
    for (let grew = true; grew; ) {
      grew = false;
      for (const [parent, schema] of Object.entries(components)) {
        const holder = types[parent];
        if (!holder) continue;
        for (const [property, value] of Object.entries(schema.properties ?? {})) {
          const target = refOf(value);
          const nested = pascal(property);
          if (!target || types[target] || !classes.nested.has(nested)) continue;
          types[target] = `${holder}.${nested}`;
          grew = true;
        }
      }
    }
    return {
      changes,
      tags,
      types,
      // What each class holds, for a release that ships no types (`stubs.mts`).
      classes: classFields(before, types),
      wire: wireOf(before),
      // Retired operations are found through stripe-node's resource files;
      // stripe-python's are not read yet, and nothing is reported for them.
      operations: {},
      drafted,
      removed,
      breaking,
    };
  }
  const declared = declaredInterfaces(sdk);
  for (const schema of schemas) {
    const name = typeNameOf(schema);
    // The interface itself is declared by its last name, inside its namespaces.
    if (declared.has(name.split(".").at(-1) ?? name)) {
      types[schema] = namespaced ? `Stripe.${name}` : name;
    }
  }
  return {
    changes,
    tags,
    types,
    operations: operationsOf(sdk, namespaced),
    drafted,
    removed,
    breaking,
  };
}
