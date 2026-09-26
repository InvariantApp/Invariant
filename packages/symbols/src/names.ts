/**
 * How generated SDKs spell a schema's name.
 *
 * Every convention here was read off a real release: Stainless keeps a
 * schema's name (`BetaMessage`) and adds `Param` for the request type
 * (`ToolParam`); Stripe turns each dot of `checkout.session` into a
 * namespace in TypeScript (`Checkout.Session`), a module in Python
 * (`checkout.Session`) and nothing in Go (`CheckoutSession`); most
 * generators PascalCase a snake_case name.
 */
import type { Language } from "./types.ts";

/** `payment_intent` as `PaymentIntent`, `usage-report` as `UsageReport`. */
export const pascal = (name: string): string =>
  name
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => (part[0] ?? "").toUpperCase() + part.slice(1))
    .join("");

/** A name with case, underscores and punctuation ignored, for a loose comparison. */
export const loose = (name: string): string =>
  name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

/** How a schema whose name has dots is spelled in each language. */
export function namespaced(schema: string, language: Language): string {
  const parts = schema.split(".");
  const last = pascal(parts.at(-1) ?? "");
  if (language === "go") return parts.map(pascal).join("");
  if (language === "python") return [...parts.slice(0, -1), last].join(".");
  return [...parts.slice(0, -1).map(pascal), last].join(".");
}

const SUFFIXES = ["Param", "Params", "Request", "Response"];

export interface Spelling {
  /** What the type would be called, possibly qualified by namespaces. */
  name: string;
  /** Which convention spelled it, for the entry's evidence. */
  rule: string;
}

/**
 * The names a schema's type could have, in the order they are tried: the
 * name itself, PascalCase, namespaces for dots, then with a request or
 * response suffix added or taken off. The first spelling any declaration
 * has wins, so an exact name is never passed over for a suffixed one.
 */
export function spellings(schema: string, language: Language): Spelling[] {
  const out: Spelling[] = [];
  const add = (name: string, rule: string) => {
    if (name !== "" && !out.some((each) => each.name === name)) out.push({ name, rule });
  };
  const dotted = schema.includes(".");
  const base = dotted ? namespaced(schema, language) : pascal(schema);
  add(schema, "the schema's own name");
  if (dotted) add(base, "each dot a namespace");
  else add(base, "the schema's name in PascalCase");
  for (const suffix of SUFFIXES) add(`${base}${suffix}`, `the ${suffix} suffix`);
  for (const suffix of SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      add(base.slice(0, -suffix.length), `without the ${suffix} suffix`);
    }
  }
  return out;
}

/**
 * Whether a qualified name ends with a spelling, segment by segment, so
 * `Stripe.Checkout.Session` is `Checkout.Session` inside `Stripe` and never
 * `Session` inside `Checkout.Sessions`.
 */
export function endsWith(qualified: string, spelling: string): boolean {
  return qualified === spelling || qualified.endsWith(`.${spelling}`);
}

/** How many segments a qualified name has; a shorter one is less nested. */
export const depth = (qualified: string): number => qualified.split(".").length;
