/**
 * Pairs each of a contract's schemas with the SDK type that implements it.
 *
 * The strategies run strongest first, and a schema placed by one is never
 * reconsidered by a weaker one:
 *
 * 1. Metadata. The SDK records the schema itself: openapi-typescript's
 *    `components["schemas"]["pet"]`, or a field pinned to the schema's own
 *    name, as Stripe's `object: 'checkout.session'`.
 * 2. Names. The first spelling a convention gives (`names.ts`) that some
 *    top-level declaration has. Then, until nothing changes, a schema only a
 *    placed type refers to is the type nested in it under the property's
 *    name, as `stripe.Subscription.AutomaticTax`.
 * 3. Structure. The one declaration whose fields are the schema's
 *    properties, sharing at least `threshold` of them (shared over both
 *    together), and strictly more than any other.
 * 4. The judge, for candidates the rest could not separate.
 *
 * Three facts rule a candidate out at every stage. A field pinned to a value
 * other than the schema's (a `LineItem` whose `object` is `'item'` is not
 * the schema `line_item`, whatever its name says); a mismatch of kind: a
 * schema with properties is implemented by something with fields, never by
 * an alias, unless the alias is a union of object types each of which is the
 * schema for some value of its discriminator; and a mismatch of direction:
 * a type only requests are built from never implements a schema only
 * responses carry.
 */
import type { SymbolJudge, TieQuestion } from "./judge.ts";
import { endsWith, loose, pascal, spellings } from "./names.ts";
import type { SchemaShape } from "./schemas.ts";
import type { Declaration, Language, SymbolEntry, Via } from "./types.ts";

export interface MatchOptions {
  language: Language;
  judge: SymbolJudge;
  /** The least share of fields in common for a structural match. */
  threshold?: number;
}

export const DEFAULT_THRESHOLD = 0.8;

/** Share of two field sets in common, compared loosely so `created_at` is `createdAt`. */
export function overlapOf(
  properties: readonly string[],
  fields: readonly string[],
): number {
  const a = new Set(properties.map(loose));
  const b = new Set(fields.map(loose));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const each of a) if (b.has(each)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Whether a declaration pins a field the schema also pins, to another value. */
function contradicts(shape: SchemaShape, declaration: Declaration): boolean {
  if (!declaration.constants) return false;
  for (const [property, value] of Object.entries(shape.constants)) {
    const pinned = declaration.constants[property];
    if (pinned !== undefined && pinned !== value) return true;
  }
  return false;
}

/** Whether a declaration could implement a schema at all. */
function eligible(shape: SchemaShape, declaration: Declaration): boolean {
  if (shape.kind === "object" && declaration.kind !== "object" && !declaration.variants) {
    return false;
  }
  // A type only requests are built from never reads what only responses carry.
  if (shape.role === "response" && isInput(declaration)) return false;
  // Nor is what a request is built from a type named for what a response
  // carries: openai's `RealtimeSessionCreateRequest` shares fields with
  // `SessionCreateResponse`, and editing one for the other would be wrong.
  const answer = /Response$/.test(declaration.name);
  if (answer && (shape.role === "request" || /Request$/.test(shape.name))) return false;
  return !contradicts(shape, declaration);
}

/** Whether a declaration is a type requests are built from, rather than one responses are read into. */
export const isInput = (declaration: Declaration): boolean =>
  declaration.input === true || /(?:Params?|TypedDict)$/.test(declaration.name);

function overlapWith(shape: SchemaShape, declaration: Declaration): number | undefined {
  if (!declaration.fields || declaration.fields.length === 0) return undefined;
  if (shape.properties.length === 0) return undefined;
  return overlapOf(shape.properties, declaration.fields);
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** The one declaration every candidate extends, directly or through each other, if there is one. */
function commonBase(
  candidates: readonly Declaration[],
  byQualified: ReadonlyMap<string, Declaration>,
): Declaration | undefined {
  if (candidates.length < 2) return undefined;
  const ancestors = (each: Declaration): Set<string> => {
    const out = new Set<string>();
    const queue = [...(each.extends ?? [])];
    while (queue.length > 0) {
      const next = queue.pop() as string;
      if (out.has(next)) continue;
      out.add(next);
      queue.push(...(byQualified.get(next)?.extends ?? []));
    }
    return out;
  };
  // A candidate the others extend is itself the base.
  const lines = candidates.map((each) => {
    const all = ancestors(each);
    all.add(each.qualified);
    return all;
  });
  const shared = [...(lines[0] as Set<string>)].filter((name) =>
    lines.every((line) => line.has(name)),
  );
  const models = shared
    .map((name) => byQualified.get(name))
    .filter(
      (each): each is Declaration =>
        each !== undefined && (each.fields?.length ?? 0) > 0 && each.kind === "object",
    );
  // The nearest: the one no other shared ancestor extends.
  const nearest = models.filter(
    (each) =>
      !models.some((other) => other !== each && ancestors(other).has(each.qualified)),
  );
  return nearest.length === 1 ? nearest[0] : undefined;
}

interface Decided {
  declaration: Declaration;
  /** How the candidates were narrowed to it, where they were. */
  narrowed?: string;
}

/**
 * Narrows equally ranked candidates by facts, before any judge: the one whose
 * pinned fields agree with the schema's, a top-level type over nested ones,
 * then the one sharing clearly more fields.
 */
function narrow(
  shape: SchemaShape,
  candidates: readonly Declaration[],
  byQualified: ReadonlyMap<string, Declaration>,
): Decided | Declaration[] {
  let remaining = candidates.filter((each) => !contradicts(shape, each));
  if (remaining.length === 1) return { declaration: remaining[0] as Declaration };
  if (remaining.length === 0) return [];
  const pins = Object.entries(shape.constants);
  if (pins.length > 0) {
    const agreeing = remaining.filter((each) =>
      pins.some(([property, value]) => each.constants?.[property] === value),
    );
    if (agreeing.length === 1) {
      const [property, value] = pins.find(
        ([key, pinned]) => agreeing[0]?.constants?.[key] === pinned,
      ) as [string, string];
      return {
        declaration: agreeing[0] as Declaration,
        narrowed: `the only one whose \`${property}\` is '${value}'`,
      };
    }
    if (agreeing.length > 1) remaining = agreeing;
  }
  // A request's type where requests alone carry the schema, a response's
  // otherwise: Stainless writes `TextBlock` and `TextBlockParam` from one
  // schema's shape, and a schema only requests carry is the second.
  if (shape.role !== "neither") {
    const wanted = shape.role === "request";
    const fitting = remaining.filter((each) => isInput(each) === wanted);
    if (fitting.length === 1) {
      return {
        declaration: fitting[0] as Declaration,
        narrowed: `the only ${wanted ? "request" : "response"} type, as ${shape.role === "request" ? "only requests carry the schema" : "responses carry the schema"}`,
      };
    }
    if (fitting.length > 1) remaining = fitting;
  }
  const top = remaining.filter((each) => each.parent === undefined);
  if (top.length === 1) {
    return { declaration: top[0] as Declaration, narrowed: "the only one not nested" };
  }
  if (top.length > 1) remaining = top;
  const exported = remaining.filter((each) => each.exported);
  if (exported.length === 1) {
    return {
      declaration: exported[0] as Declaration,
      narrowed: "the only one its package exports",
    };
  }
  if (exported.length > 1) remaining = exported;
  // Types that tie because each extends one base with the same few extra
  // fields, as Stainless's `MessageCreateParamsStreaming` and
  // `...NonStreaming` extend `MessageCreateParamsBase`, are that base; and a
  // type the others extend, as `ParsedChatCompletion` extends
  // `ChatCompletion`, is the one the schema describes.
  const base = commonBase(remaining, byQualified);
  if (base && eligible(shape, base)) {
    return {
      declaration: base,
      narrowed: remaining.includes(base)
        ? "the one the others extend"
        : `the ${base.name} that ${remaining.map((each) => each.name).join(" and ")} each extend`,
    };
  }
  const scored = remaining
    .map((each) => ({ each, overlap: overlapWith(shape, each) }))
    .sort((a, b) => (b.overlap ?? -1) - (a.overlap ?? -1));
  const [first, second] = scored;
  if (
    first?.overlap !== undefined &&
    second !== undefined &&
    first.overlap - (second.overlap ?? 0) >= 0.1
  ) {
    return {
      declaration: first.each,
      narrowed: `sharing ${round(first.overlap)} of its fields against ${round(second.overlap ?? 0)}`,
    };
  }
  return remaining;
}

interface Tie {
  shape: SchemaShape;
  stage: TieQuestion["stage"];
  candidates: Declaration[];
  /** What found the candidates, for the evidence. */
  found: string;
  via: Via;
}

export interface TypeMatches {
  types: Record<string, SymbolEntry>;
  unmatched: Record<string, string>;
}

/** Pairs every schema with the declaration that implements it. */
export async function matchTypes(
  shapes: readonly SchemaShape[],
  declarations: readonly Declaration[],
  options: MatchOptions,
): Promise<TypeMatches> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const types: Record<string, SymbolEntry> = {};
  const unmatched: Record<string, string> = {};
  const byQualified = new Map(declarations.map((each) => [each.qualified, each]));
  const top = declarations.filter((each) => each.parent === undefined);

  const place = (
    shape: SchemaShape,
    declaration: Declaration,
    via: Via,
    confidence: number,
    evidence: string,
  ) => {
    const overlap = overlapWith(shape, declaration);
    let sure = confidence;
    let why = evidence;
    // A name the fields disagree with is still the likeliest type, and says
    // so less firmly.
    if (via === "name" && overlap !== undefined && overlap < 0.5) {
      sure *= 0.8;
      why += `, though they share only ${round(overlap)} of their fields`;
    }
    types[shape.name] = {
      symbol: declaration.qualified,
      via,
      confidence: round(sure),
      evidence: why,
      ...(overlap !== undefined ? { overlap: round(overlap) } : {}),
      ...(declaration.package !== undefined ? { package: declaration.package } : {}),
      file: declaration.file,
    };
  };

  const settle = (
    shape: SchemaShape,
    candidates: readonly Declaration[],
    via: Via,
    confidence: number,
    found: string,
    stage: TieQuestion["stage"],
    ties: Tie[],
  ) => {
    const decided = narrow(shape, candidates, byQualified);
    if (!Array.isArray(decided)) {
      place(
        shape,
        decided.declaration,
        via,
        decided.narrowed ? confidence * 0.9 : confidence,
        decided.narrowed
          ? `${found}; of ${candidates.length}, ${decided.narrowed}`
          : found,
      );
    } else if (decided.length > 1) {
      ties.push({ shape, stage, candidates: decided, found, via });
    }
  };

  const judge = async (ties: Tie[]) => {
    if (ties.length === 0) return;
    const answers = await options.judge.choose(
      ties.map((tie) => ({
        schema: tie.shape.name,
        properties: tie.shape.properties,
        stage: tie.stage,
        candidates: tie.candidates.map((each) => {
          const overlap = overlapWith(tie.shape, each);
          return {
            qualified: each.qualified,
            file: each.file,
            ...(each.fields ? { fields: each.fields } : {}),
            ...(overlap !== undefined ? { overlap: round(overlap) } : {}),
          };
        }),
      })),
    );
    ties.forEach((tie, index) => {
      const answer = answers[index];
      const chosen = answer?.choice
        ? tie.candidates.find((each) => each.qualified === answer.choice)
        : undefined;
      if (!answer || !chosen) {
        unmatched[tie.shape.name] =
          `${tie.found}, ${tie.candidates.length} candidates (${tie.candidates
            .map((each) => each.qualified)
            .join(
              ", ",
            )}), and the ${options.judge.id} judge chose none: ${answer?.reason ?? "no answer"}`;
        return;
      }
      place(
        tie.shape,
        chosen,
        "judge",
        answer.confidence,
        `${tie.found}; the ${options.judge.id} judge chose it from ${tie.candidates.length}: ${answer.reason}`,
      );
    });
  };

  // 1. What the SDK records about each schema.
  const bySchema = new Map<string, Declaration[]>();
  const byTag = new Map<string, Declaration[]>();
  for (const each of declarations) {
    if (each.schema !== undefined) {
      bySchema.set(each.schema, [...(bySchema.get(each.schema) ?? []), each]);
    }
    for (const [property, value] of Object.entries(each.constants ?? {})) {
      const key = `${property}\u0000${value}`;
      byTag.set(key, [...(byTag.get(key) ?? []), each]);
    }
  }
  const metadataTies: Tie[] = [];
  for (const shape of shapes) {
    const recorded = (bySchema.get(shape.name) ?? []).filter((each) =>
      eligible(shape, each),
    );
    if (recorded.length > 0) {
      settle(
        shape,
        recorded,
        "metadata",
        1,
        `the SDK declares it as the schema \`${shape.name}\``,
        "metadata",
        metadataTies,
      );
      continue;
    }
    // The name a generator's extension on the schema gives its type.
    if (shape.named) {
      const { name, extension } = shape.named;
      const named = top.filter(
        (each) =>
          eligible(shape, each) && (each.name === name || endsWith(each.qualified, name)),
      );
      if (named.length > 0) {
        settle(
          shape,
          named,
          "metadata",
          0.95,
          `the contract's \`${extension}\` names it ${name}`,
          "metadata",
          metadataTies,
        );
        continue;
      }
    }
    // A field the schema pins to its own name is the schema's tag, and a
    // type pinning the same field to it says which schema it is.
    const tag = Object.entries(shape.constants).find(([, value]) => value === shape.name);
    if (!tag) continue;
    const tagged = (byTag.get(`${tag[0]}\u0000${tag[1]}`) ?? []).filter((each) =>
      eligible(shape, each),
    );
    if (tagged.length === 0) continue;
    // Several types carry one tag, as `DeletedCustomer` carries `customer`:
    // the one the naming conventions agree with is the schema's.
    const named = spellings(shape.name, options.language)
      .map((spelling) => tagged.filter((each) => endsWith(each.qualified, spelling.name)))
      .find((found) => found.length > 0);
    settle(
      shape,
      named ?? tagged,
      "metadata",
      0.95,
      `its \`${tag[0]}\` is pinned to '${tag[1]}', the schema's name${named && tagged.length > 1 ? ", and its name agrees" : ""}`,
      "metadata",
      metadataTies,
    );
  }
  await judge(metadataTies);

  // The one type sharing the most fields with a schema, at least `threshold`
  // of them, where one does.
  const withFields = declarations.filter(
    (each) => each.kind === "object" && (each.fields?.length ?? 0) > 0,
  );
  const strongest = (
    shape: SchemaShape,
  ): { declarations: Declaration[]; share: number } | undefined => {
    if (shape.kind !== "object" || shape.properties.length < 2) return undefined;
    let share = 0;
    let found: Declaration[] = [];
    for (const each of withFields) {
      if (!eligible(shape, each)) continue;
      const overlap = overlapOf(shape.properties, each.fields ?? []);
      if (overlap > share) {
        share = overlap;
        found = [each];
      } else if (overlap === share && overlap > 0) found.push(each);
    }
    return share >= threshold ? { declarations: found, share } : undefined;
  };
  /** Names a structural match overruled, for the evidence of the match. */
  const overruled = new Map<string, string>();

  // 2. Names, then the types nested in the placed ones.
  const nameTies: Tie[] = [];
  for (const shape of shapes) {
    if (types[shape.name] || unmatched[shape.name]) continue;
    let found = false;
    for (const spelling of spellings(shape.name, options.language)) {
      const candidates = top.filter(
        (each) => eligible(shape, each) && endsWith(each.qualified, spelling.name),
      );
      if (candidates.length === 0) continue;
      // A name whose type shares under half the schema's fields, when some
      // other type shares nearly all of them, names the wrong thing: Stripe's
      // `line_item` is an invoice's line, and stripe-go's `LineItem` a
      // checkout session's. The fields decide, below.
      const shares = candidates.map((each) => overlapWith(shape, each));
      if (shares.every((share) => share !== undefined && share < 0.5)) {
        const better = strongest(shape);
        if (better?.declarations.every((each) => !candidates.includes(each))) {
          overruled.set(
            shape.name,
            `, over ${candidates.map((each) => each.qualified).join(" and ")}, which its name spells but which shares only ${round(Math.max(...shares.map((share) => share ?? 0)))} of its fields`,
          );
          found = true;
          break;
        }
      }
      const exact = spelling.rule === "the schema's own name";
      const suffixed = / suffix$/.test(spelling.rule);
      // A suffix added says which way the type goes: stripe-go's
      // `InvoiceLineItemPeriodParams` is what a request sends, never the
      // `invoice_line_item_period` only responses carry.
      const added = /^the (\w+) suffix$/.exec(spelling.rule)?.[1];
      if (
        added !== undefined &&
        (shape.role === "request" || shape.role === "response") &&
        (added === "Response") !== (shape.role === "response")
      ) {
        continue;
      }
      // A suffix added or taken off is a weaker reading of the name: it
      // counts only where it picks out one type (`UsageResponse` without
      // `Response` is any of an SDK's several `Usage` classes).
      if (suffixed && Array.isArray(narrow(shape, candidates, byQualified))) continue;
      found = true;
      settle(
        shape,
        candidates,
        "name",
        exact ? 0.9 : suffixed ? 0.8 : 0.85,
        `named ${spelling.name}, ${spelling.rule}`,
        "name",
        nameTies,
      );
      break;
    }
    if (found) continue;
    // The name with case and punctuation ignored, where only one type has it.
    const key = loose(shape.name);
    const loosely = top.filter(
      (each) => eligible(shape, each) && loose(each.name) === key,
    );
    if (loosely.length === 1) {
      place(
        shape,
        loosely[0] as Declaration,
        "name",
        0.7,
        `named ${(loosely[0] as Declaration).name}, the schema's name ignoring case and punctuation`,
      );
    }
  }
  await judge(nameTies);

  if (options.language !== "go") {
    const holders = new Map<string, number>();
    for (const shape of shapes) {
      for (const [, target] of shape.refs)
        holders.set(target, (holders.get(target) ?? 0) + 1);
    }
    const byName = new Map(shapes.map((shape) => [shape.name, shape]));
    for (let grew = true; grew; ) {
      grew = false;
      for (const parent of shapes) {
        const holder = types[parent.name];
        if (!holder) continue;
        for (const [property, target] of parent.refs) {
          const shape = byName.get(target);
          if (!shape || types[target] || unmatched[target]) continue;
          const nested = byQualified.get(`${holder.symbol}.${pascal(property)}`);
          if (!nested || nested.parent !== holder.symbol || !eligible(shape, nested))
            continue;
          const shared = holders.get(target) ?? 1;
          place(
            shape,
            nested,
            "name",
            shared > 1 ? 0.6 : 0.85,
            `the type of \`${parent.name}.${property}\`, nested in ${holder.symbol} under the property's name` +
              (shared > 1
                ? `; ${shared} properties refer to the schema, and this is the first`
                : ""),
          );
          grew = true;
        }
        // A property that is one of several schemas has one nested type,
        // which is the one of them whose fields it has: Stripe's
        // `payment_method_options.link` is its own `..._options_link` or a
        // shared client type, and `PaymentMethodOptions.Link` is the first.
        for (const [property, targets] of parent.choices) {
          const nested = byQualified.get(`${holder.symbol}.${pascal(property)}`);
          if (!nested || nested.parent !== holder.symbol) continue;
          // One of the choices is already this type.
          if (targets.some((target) => types[target]?.symbol === nested.qualified))
            continue;
          const open = targets
            .map((target) => byName.get(target))
            .filter(
              (shape): shape is SchemaShape =>
                shape !== undefined &&
                !types[shape.name] &&
                !unmatched[shape.name] &&
                eligible(shape, nested),
            )
            .map((shape) => ({ shape, share: overlapWith(shape, nested) ?? 0 }))
            .sort((a, b) => b.share - a.share);
          const [first, second] = open;
          if (!first || first.share < 0.5 || (second && second.share === first.share))
            continue;
          place(
            first.shape,
            nested,
            "name",
            0.75,
            `the type of \`${parent.name}.${property}\`, nested in ${holder.symbol} under the property's name, the one of its ${targets.length} choices whose fields it has`,
          );
          grew = true;
        }
      }
    }
  }

  // 3. Structure, for what no name found.
  const structureTies: Tie[] = [];
  const bests = new Map<SchemaShape, NonNullable<ReturnType<typeof strongest>>>();
  for (const shape of shapes) {
    if (types[shape.name] || unmatched[shape.name]) continue;
    const best = strongest(shape);
    if (best) bests.set(shape, best);
  }
  // Fields alone cannot tell apart schemas that differ only in a pinned
  // value: stripe-go's `PaymentSource` has exactly the `deleted`, `id` and
  // `object` of every `deleted_*` schema, and is none of them. A type the
  // fields give to schemas pinning one property to different values is
  // given to none.
  const pins = new Map<Declaration, Map<string, Set<string>>>();
  for (const [shape, best] of bests) {
    for (const each of best.declarations) {
      const seen = pins.get(each) ?? new Map<string, Set<string>>();
      for (const [property, value] of Object.entries(shape.constants)) {
        seen.set(property, (seen.get(property) ?? new Set()).add(value));
      }
      pins.set(each, seen);
    }
  }
  const ambiguous = (each: Declaration) =>
    [...(pins.get(each)?.values() ?? [])].some((values) => values.size > 1);
  for (const shape of shapes) {
    const best = bests.get(shape);
    if (!best) continue;
    const clear = best.declarations.filter((each) => !ambiguous(each));
    if (clear.length === 0) {
      unmatched[shape.name] =
        `no declaration has its name, and the fields of ${best.declarations.map((each) => each.qualified).join(" and ")} fit other schemas that pin its values differently`;
      continue;
    }
    best.declarations = clear;
    const found = `shares ${round(best.share)} of its fields, at least ${threshold}${overruled.get(shape.name) ?? ""}`;
    settle(
      shape,
      best.declarations,
      "structure",
      round(0.9 * best.share),
      found,
      "structure",
      structureTies,
    );
  }
  await judge(structureTies);

  for (const shape of shapes) {
    if (types[shape.name] || unmatched[shape.name]) continue;
    unmatched[shape.name] = "no declaration has its name, and none has its fields";
  }
  return { types, unmatched };
}
