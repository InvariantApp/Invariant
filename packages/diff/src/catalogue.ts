/**
 * What every breaking-change id the differ can report means for a provider.
 *
 * The differ names a delta; this says what can be done about it. Each id is
 * placed in one class, with the IR op that expresses it where there is one,
 * whether the runtime serves that today, and a sentence a provider reads in
 * the pull request comment. The gate, the comment and the documentation all
 * read it from here, so they cannot disagree about what a delta means.
 *
 * It is a table of rules over the ids' own structure, not a list: the pinned
 * oasdiff knows 755 checks, and their names say their area, direction and
 * kind. The first rule that matches decides. A test runs every id the pinned
 * binary prints through it and fails if any falls through to the fallback, so
 * a new differ release cannot add an id nobody classified.
 */
import { BREAKING_INFO_IDS, BREAKING_WARN_IDS } from "./policy.ts";

export type CatalogueClass =
  /** Served by an op the rules can draft with no one deciding anything. */
  | "adaptable"
  /** Served by an op once the provider decides something, such as a default. */
  | "needs-decision"
  /** No translation can hide it; a `behavior` flag is the honest answer. */
  | "behavior-only"
  /** A rule about how the provider deprecates, which no caller sees. */
  | "process"
  /** Reported by the differ, and not a break. */
  | "non-breaking";

export interface CatalogueEntry {
  class: CatalogueClass;
  /** The IR op that expresses it, where one does. */
  op?: string;
  /**
   * Whether the runtime serves it now. `planned` names what has to exist
   * first, so a comment never promises what the product cannot yet do.
   */
  served: "yes" | "planned" | "not applicable";
  /** What the provider reads. One or two sentences, no jargon beyond the op. */
  sentence: string;
}

interface Rule {
  match: RegExp;
  entry: CatalogueEntry;
}

const BEHAVIOR =
  "No translation can hide this from an old caller. Declare it as a `behavior` flag and branch on it in your own code, or keep the old behaviour for old contracts.";

const rule = (match: RegExp, entry: CatalogueEntry): Rule => ({ match, entry });

/** Ordered: the first rule that matches an id decides it. */
const RULES: Rule[] = [
  // Breaks by Invariant's policy that oasdiff files as information.
  rule(/^response-required-property-added$/, {
    class: "adaptable",
    op: "add",
    served: "yes",
    sentence:
      "Responses now always carry a field old callers were never promised. An `add` takes it out of their responses, so a strict client validating against its contract still passes.",
  }),
  rule(/^api-operation-id-removed$/, {
    class: "adaptable",
    op: "route",
    served: "yes",
    sentence:
      "An operation's id changed. Nothing on the wire moves, but a generated client renames the method; a `route` with `operationId` records it, so consumers' calls are renamed in their migration.",
  }),

  // Endpoints and webhooks that are gone.
  rule(/^api-(path-)?removed-(without-deprecation|before-sunset)$/, {
    class: "adaptable",
    op: "retire",
    served: "yes",
    sentence:
      "An operation is gone from the specification. A `retire` is drafted: old callers still reach your server, and when it answers 405 or 410 they are told what to use instead. Mark it `refuse: true` once your server no longer serves the operation.",
  }),
  rule(/^webhook-removed$/, {
    class: "behavior-only",
    served: "not applicable",
    sentence:
      "A webhook you sent is no longer sent. Nothing can stand in for an event that is not produced; tell the subscribers who depend on it.",
  }),

  // How the provider deprecates: rules about the specification, not breaks.
  rule(/(^|-)(sunset|deprecated-sunset|stability)(-|$)|^api-invalid-stability-level$/, {
    class: "process",
    served: "not applicable",
    sentence:
      "This is a rule about how an operation or field is deprecated, not a change an old caller sees. Fix the dates or stability levels in the specification.",
  }),

  // Authentication.
  rule(/security/, {
    class: "behavior-only",
    served: "not applicable",
    sentence:
      "Authentication changed. An adapter must never alter who is allowed to call what, so old callers have to update their credentials; tell them directly.",
  }),

  // Status codes and media types of whole responses and request bodies.
  rule(/^response-success-status-removed$/, {
    class: "behavior-only",
    served: "not applicable",
    sentence: `A success status an old caller relies on is no longer returned. ${BEHAVIOR}`,
  }),
  rule(/^(response-(body-)?media-type|response-body-content|response-media-type)-/, {
    class: "behavior-only",
    served: "not applicable",
    sentence: `What a response is encoded as changed. ${BEHAVIOR}`,
  }),
  rule(/^request-body-(media-type-removed|content-(encoding|media-type)-changed)$/, {
    class: "needs-decision",
    op: "convert",
    served: "planned",
    sentence:
      "The encoding a request body is accepted in changed. Translating one body encoding into another needs the body codecs, which are not served yet; until then keep accepting the old encoding.",
  }),
  rule(/^request-body-media-type-(item-)?schema-added$/, {
    class: "behavior-only",
    served: "not applicable",
    sentence: `A request body now has a schema it did not have. ${BEHAVIOR}`,
  }),
  rule(/^request-body-(added-required|became-required)$/, {
    class: "needs-decision",
    op: "add",
    served: "planned",
    sentence:
      "A request body became required. Old callers who sent none need one supplied for them, which you decide; supplying a whole body is not served yet.",
  }),
  rule(/^request-body-removed$/, {
    class: "needs-decision",
    op: "remove",
    served: "planned",
    sentence:
      "An operation no longer takes a body. Dropping the body old callers still send is not served yet; until then keep ignoring it.",
  }),

  // Parameters, which the runtime serves once the request envelope exists.
  rule(
    /^request-(parameter|header-property)-.*(max|min|pattern|exclusive|items|length|properties|contains|multiple-of).*$/,
    {
      class: "behavior-only",
      served: "not applicable",
      sentence: `A parameter now refuses values the old contract allowed. Rewriting a caller's value into a different one would change what they asked for. ${BEHAVIOR}`,
    },
  ),
  rule(/^request-parameter-(removed|removed-before-sunset)$/, {
    class: "adaptable",
    op: "remove",
    served: "planned",
    sentence:
      "A parameter was removed. Old callers who still send it can have it dropped, or moved if another parameter replaced it; parameters are served once the request envelope lands.",
  }),
  rule(
    /^(new-required-request-(default-)?parameter|new-required-request-parameter|new-request-path-parameter|new-required-request-header-property|new-required-request-default-parameter-to-existing-path|request-(parameter|header-property)-became-required)/,
    {
      class: "needs-decision",
      op: "add",
      served: "planned",
      sentence:
        "A parameter old callers never sent is now required. It can be supplied for them with a value you decide; parameters are served once the request envelope lands.",
    },
  ),
  rule(
    /^request-(parameter|header-property)(-property)?-(became-enum|enum-value-removed|x-extensible-enum-value-removed)$/,
    {
      class: "needs-decision",
      op: "convert",
      served: "planned",
      sentence:
        "A parameter no longer accepts some values old callers send. An enum map can translate them into values it does accept, which you decide; parameters are served once the request envelope lands.",
    },
  ),
  rule(/^request-(parameter|header-property)(-property)?-/, {
    class: "needs-decision",
    op: "convert",
    served: "planned",
    sentence:
      "A parameter's type or nullability changed. A conversion can translate old callers' values, which you confirm; parameters are served once the request envelope lands.",
  }),

  // Response headers, served with the envelope too.
  rule(
    /^response-header-.*(max|min|pattern|exclusive|items|length|properties|contains|multiple-of)/,
    {
      class: "needs-decision",
      served: "planned",
      sentence:
        "A response header may now hold values outside what old callers were promised. Passing them through is a declared loss you acknowledge; clamping them is not served yet.",
    },
  ),
  rule(/^(required-response-header-removed|response-header-)/, {
    class: "needs-decision",
    op: "add",
    served: "planned",
    sentence:
      "A response header old callers relied on changed or may be missing. It can be restored or converted with a value you decide; headers are served once the request envelope lands.",
  }),

  // Request bodies: constraints that narrow refuse what old callers send.
  rule(
    /^request-(body|property)-(.*-)?(max|min|pattern|exclusive|items|length|properties|contains|multiple-of|unique-items)(-.*)?$/,
    {
      class: "behavior-only",
      served: "not applicable",
      sentence: `A request field now refuses values the old contract allowed. Rewriting a caller's value into a different one would change what they asked for. ${BEHAVIOR}`,
    },
  ),
  rule(
    /^(new-required-request-property-with-default|request-property-became-required-with-default)$/,
    {
      class: "adaptable",
      op: "add",
      served: "yes",
      sentence:
        "A request field old callers never sent is now required, and the specification gives its default. An `add` supplies it for them.",
    },
  ),
  rule(/^(new-required-request-property|request-property-became-required)$/, {
    class: "needs-decision",
    op: "add",
    served: "yes",
    sentence:
      "A request field old callers never sent is now required. An `add` supplies it for them, with a value you decide.",
  }),
  rule(/^request-property-removed$/, {
    class: "adaptable",
    op: "move",
    served: "yes",
    sentence:
      "A request field was removed. If another field replaced it, a `move` translates old callers' requests; if nothing did, a `remove` drops what they still send.",
  }),
  rule(
    /^request-(body|property)-(became-enum|enum-value-removed|x-extensible-enum-value-removed)$/,
    {
      class: "needs-decision",
      op: "convert",
      served: "yes",
      sentence:
        "A request field no longer accepts some values old callers send. An enum map translates them into values it does accept, which you decide.",
    },
  ),
  rule(/^request-(body|property)-(type-changed|list-of-types-narrowed)$/, {
    class: "needs-decision",
    op: "convert",
    served: "yes",
    sentence:
      "A request field's type changed. A `cast` or `scale10` conversion translates old callers' values, which you confirm.",
  }),
  rule(/^request-(body|property)-became-not-nullable$/, {
    class: "needs-decision",
    op: "remove",
    served: "planned",
    sentence:
      "A request field no longer accepts null. Dropping a null an old caller sends, or replacing it with a value you decide, is not served yet.",
  }),
  rule(
    /^request-(body|property)-(any-of-removed|one-of-removed|all-of-added|wrapped-in-one-of(-original-preserved)?)$/,
    {
      class: "needs-decision",
      op: "convert",
      served: "planned",
      sentence:
        "A request field accepts fewer shapes than it did. Translating the shapes old callers send needs the union instructions, which are not served yet.",
    },
  ),
  rule(/^request-(body|property)-/, {
    class: "behavior-only",
    served: "not applicable",
    sentence: `A request field now has a rule old callers' values may not satisfy. ${BEHAVIOR}`,
  }),

  // Responses: what an old caller is promised and may no longer get.
  rule(/^response-property-enum-value-added$/, {
    class: "needs-decision",
    op: "convert",
    served: "yes",
    sentence:
      "A response field can now hold a value old callers do not know. An enum map with a `fold` shows them one they do, which you choose; that is a declared loss, and the pull request asks you to acknowledge it.",
  }),
  rule(/^response-(body|property)-type-changed$/, {
    class: "needs-decision",
    op: "convert",
    served: "yes",
    sentence:
      "A response field's type changed. A `cast` or `scale10` conversion translates it back for old callers, which you confirm.",
  }),
  rule(/^response-required-property-removed$/, {
    class: "needs-decision",
    op: "remove",
    served: "yes",
    sentence:
      "A response field old callers were always given is gone. A `remove` restores it for them with a value you decide, or a `move` if another field replaced it.",
  }),
  rule(/^response-(body|property)-(became-optional|became-nullable)$/, {
    class: "needs-decision",
    op: "add",
    served: "planned",
    sentence:
      "A response field old callers were always given may now be missing or null. Filling it in for them with a value you decide is not served yet.",
  }),
  rule(
    /^response-(body|property)-(any-of-added|one-of-added|all-of-removed|wrapped-in-one-of(-original-preserved)?)$/,
    {
      class: "needs-decision",
      op: "convert",
      served: "planned",
      sentence:
        "A response field can now take shapes old callers do not know. Folding a new shape into one they do needs the union instructions, which are not served yet.",
    },
  ),
  rule(/^response-(body|property)-/, {
    class: "needs-decision",
    served: "planned",
    sentence:
      "Old callers may now receive values outside what their contract promised. Passing them through is a declared loss you acknowledge; clamping them is not served yet.",
  }),
];

const FALLBACK: CatalogueEntry = {
  class: "behavior-only",
  served: "not applicable",
  sentence: `Not yet classified. ${BEHAVIOR}`,
};

const NON_BREAKING: CatalogueEntry = {
  class: "non-breaking",
  served: "not applicable",
  sentence: "Reported for information. Old callers are not affected.",
};

/**
 * What an id means. Whether it is a break at all is decided as the gate
 * decides it, from the differ's level and Invariant's own pinned exceptions,
 * so the catalogue can never call a delta harmless that the gate blocks on.
 * Without a level it is taken to be a break.
 */
export function catalogueEntry(
  id: string,
  level?: "error" | "warning" | "info",
): CatalogueEntry {
  const breaking =
    level === undefined ||
    level === "error" ||
    BREAKING_WARN_IDS.has(id) ||
    BREAKING_INFO_IDS.has(id);
  if (!breaking) return NON_BREAKING;
  return RULES.find((candidate) => candidate.match.test(id))?.entry ?? FALLBACK;
}

/** True when no rule decided the id, which the catalogue test forbids. */
export function isUnclassified(id: string): boolean {
  return !RULES.some((candidate) => candidate.match.test(id));
}
