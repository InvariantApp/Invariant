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
import { propose, RulesJudge } from "@invariant-app/proposer";
import { ROOT } from "../corpus/manifest.mts";

const SPECS = join(ROOT, ".cache/replay/specs");
const TAGS = join(SPECS, "stripe-openapi-tags.json");

/** Which of Stripe's SDKs a release number belongs to. */
export type StripeSdk = "stripe-node" | "stripe-python";

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
  const response = await fetch(
    `https://raw.githubusercontent.com/stripe/${sdk}/v${version}/OPENAPI_VERSION`,
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
  /** Schema name to the old SDK's type for it. */
  types: Record<string, string>;
  /** Each operation to the SDK method that calls it. */
  operations: Record<string, { type: string; method: string }>;
  /** Drafts, and removals no judge could pair, for the record. */
  drafted: number;
  removed: number;
}

/**
 * Every class a stripe-python release declares at the top of a module, by
 * its name: `Subscription` in `stripe/_subscription.py`, `Session` in
 * `stripe/checkout/_session.py`.
 */
function declaredClasses(dir: string, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 4) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) declaredClasses(path, found, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".py")) {
      for (const match of readFileSync(path, "utf8").matchAll(/^class (\w+)\b/gm)) {
        found.add(match[1] as string);
      }
    }
  }
  return found;
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
  // One after the other: each records what it found in the same file.
  const oldRelease = await openapiRelease(from, flavour);
  const newRelease = await openapiRelease(to, flavour);
  const [before, after] = await Promise.all([
    specification(oldRelease),
    specification(newRelease),
  ]);
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
      if (classes.has(name.split(".").at(-1) ?? name)) types[schema] = name;
    }
    return {
      changes: [...outcome.proposals.map((proposal) => proposal.change), ...removals],
      types,
      // Retired operations are found through stripe-node's resource files;
      // stripe-python's are not read yet, and nothing is reported for them.
      operations: {},
      drafted: outcome.proposals.length,
      removed: removals.length,
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
    changes: [...outcome.proposals.map((proposal) => proposal.change), ...removals],
    types,
    operations: operationsOf(sdk, namespaced),
    drafted: outcome.proposals.length,
    removed: removals.length,
  };
}
