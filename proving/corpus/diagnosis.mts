/**
 * What each unexplained kind actually means for this system.
 *
 * A ranked list of check ids is a list. A ranked list with a diagnosis beside
 * each one is a to-do list, and the whole point of running real documents is
 * to produce the second.
 */
export const DIAGNOSIS: Record<string, string> = {
  "api-path-removed-without-deprecation":
    "an endpoint genuinely gone, not moved. `retire` expresses it and the proposer drafts one for explicit attention; the runtime answers an old caller with 410 and the provider's guidance. Nothing can serve the call, so the gate weighs it against the usage ledger.",
  "response-body-type-changed":
    "a response schema replaced wholesale, often with an empty one. Not expressible and probably should not be: it is a rewrite, not a rename.",
  "request-parameter-enum-value-removed":
    "allowed values narrowed on a query or path parameter. The proposer drafts an `enumMap` for it, and the gate then blocks, because the runtime does not yet rewrite parameters. **Drafted, not yet servable.**",
  "request-parameter-removed":
    "a query or path parameter dropped. The proposer reads parameters now but drafts only narrowed enums, and the runtime does not yet rewrite parameters at all. **Not yet servable.**",
  "request-parameter-property-enum-value-removed":
    "as above, one level in. **Not yet servable.**",
  "response-property-enum-value-added":
    "a new value a client switching exhaustively would not know. Expressible: `enumMap` takes a `fold`, which says which existing value an old caller should be shown instead. Which value that is cannot be read off the documents, so it needs one sentence from the provider, and it is declared lossy because the caller cannot tell the new case apart. **Reachable, needs a decision.**",
  "response-property-enum-value-removed":
    "a value a client may still be storing. `enumMap` can express it once someone says what it became, which is exactly the question the model is asked.",
  "request-property-removed":
    "a field dropped from a request. `remove` expresses it; the rules judge abstains on removals by design, so this needs the model or a person.",
  "response-required-property-added":
    "a new required field in a response. `add` expresses it, given a value for callers who predate it, which is not in the document.",
  "response-required-property-removed":
    "a required response field gone. `remove` with a restore value expresses it; again the value is not in the document.",
  "new-required-request-property":
    "a new required request field. `add` with a default expresses it, and the default is a decision rather than a fact.",
  "request-property-type-changed":
    "`cast` covers the scalar cases. Anything structural is out of scope on purpose.",
  "response-property-type-changed":
    "a response field whose declared type moved. `cast` covers the scalar cases once someone says the two are the same field, which is the alignment question.",
  "response-property-became-optional":
    "a field a caller relied on may now be absent. Expressible only by supplying a value, which is a judgement.",
  "request-property-became-required":
    "a caller who omitted it will now be refused. `add` with a default expresses it.",
};
