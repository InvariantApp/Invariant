# @invariant-app/runtime

## 0.5.0

### Minor Changes

- eeeb512: `invariant compile` writes `invariant.lock` beside the program, naming it by the digest the evolution bundle records. Given that digest as `programDigest`, `createRuntime` refuses at load any other program, so one changed between the build and the server is never served; `programDigest` is exported for checking a program by hand.
  
  `invariant check` refuses a release whose behavior flag is used in authentication or authorization code, found by the file's path or the words around the flag. A caller chooses its own contract, so a branch on it there would let a caller choose its own permissions.
  
  `migrate` takes an optional `repair`, a model asked for each function a site was left to a person in. It is sent the Change, why the site was left, and that function only; what it returns is kept only as that one function, type-checking as well as before, and is reported in `repairs` as the model's. Without `repair` no model is asked.
  
  The oasdiff platform packages carry a CycloneDX bill of materials naming the upstream binary by version, source and hash, as every other package already does.

### Patch Changes

- @invariant-app/decimal@0.5.0

## 0.4.0

### Minor Changes

- 407f319: A new op, `status {endpoint, from, to}`, for an operation that answers with another success status: Gitea 1.25 answers the creation of an Actions variable `201` where 1.24 answered `204`, and Immich 1.138 answers `204` where 1.137 answered `200` with nothing. An old caller is answered `from` wherever the operation now answers `to`, and what happens to the body is read from the two contracts: none where the old contract promised none, the body served as any body is where both carry one, and the Change refused where the old status promised a body the new one does not carry. It is exact. A success status removed is now adaptable, and the proposer drafts the op where the documents settle which status replaced which. Programs carry it as a site's `status` rules, which the TypeScript runtime, the Node binding and the Go engine's net/http middleware apply in turn to the provider's status, and which compose across a chain of releases; the response work of a release is filed under the status the provider answers with. A chain now finds each release's response work for a status as the runtime does, by the exact status, then its class, then `default`. A `move` may place a value beneath its own place, as Meilisearch's list of a rule's actions became the `pin` list of an object there, and a field of an object that declares no properties may be moved out of it. The TypeScript runtime now writes a copy of an object a `set` writes, as the Go engine always has, so a later write into one place no longer reaches every place it was written and the program itself. The proxy passes on an empty Host, HTTP/1.1's way of naming no host, where it refused it: Immich's suite sends one to see its share pages fall back to their public address. And a GET that came with a body is sent on without the length of the body it is not sent, where the provider waited for bytes that never came.
- ca7c00e: XML bodies are served. Amazon's CloudFront and CloudSearch declare every body as `text/xml`, and every Change to them was left unexplained because nothing read XML. The contract now reads an operation's XML body where it has no JSON one, so the proposer drafts for it and the prediction checks it as it does JSON; the compiler describes each XML body a site has work for, from the schema's OpenAPI `xml` object (element or attribute, wrapped or not, names, namespaces and what each place holds), as a site's `xml` program, a new program feature that asks for the next runtime; and the TypeScript runtime, the Node binding and the Go engine with its net/http middleware decode such a body into a tree, run the same instructions and write it back. Only the places the program names are decoded: every other element, and everything between elements, is written back exactly as it came, so a document nothing changed comes out byte for byte. The parser is written for hostile input: a document type declaration is refused, so no entity is expanded and nothing external is read, and nesting and namespace declarations are capped. What cannot be written back exactly is refused rather than guessed at: text among an object's elements, attributes on a value, an encoding other than UTF-8, and, at compile time, a map, a schema that contains itself, or a value read whose schema says nothing of it, which the release gate blocks. A program that reaches a parameter and an XML body at once is served too, as one with a form body is. A restatement of a whole body is no longer refused as a value with nowhere to be written back, since it writes nothing: CloudSearch restates each request body whole. The proposer also no longer asks a vocabulary decision where a case codec already serves the field, as Adyen's `Active` becoming `active`.

### Patch Changes

- 5da65b3: Tests only: the status test holds before and after a release writes its version in, and the numeric fidelity benchmark asserts which parse each mode takes rather than which of two timings came out lower.
- @invariant-app/decimal@0.4.0

## 0.3.0

### Patch Changes

- 9dc889d: The proxy sends your API the caller's `Host` and no forwarding headers the caller did not send, apart from `X-Forwarded-For` and, where it terminated TLS, `X-Forwarded-Proto`; `"upstreamHost": "upstream"` keeps the old behaviour for an API that routes by its own host name. It calls your API with Node's own HTTP client, so a body sent with a `205` reaches the caller, adapted where the program says so; `responseOf` in the runtime rebuilds a response around any status without dropping its body. Found by running go-sdk's own suite through the proxy to Gitea, whose avatar links and marked notifications both broke.
- @invariant-app/decimal@0.3.0

## 0.2.0

### Minor Changes

- a530d28: A new codec, `dropValues {values}`, for a list whose items no longer accept some values an old caller may send: the values are left out of the list on the way in and the rest is served, a loss the Change declares. Asana took a hundred and twenty-six fields out of what a portfolio's items may be asked to include, and an old caller asking for `opt_fields=color` was refused outright; the proposer now drafts this for a list parameter whose values only went, and asks where others arrived beside them. Runtimes run it as the new `drop` instruction, in the Go engine too. A feature added since the last release is now entered as `NEXT` and asks for a pre-release of the next patch, which every published runtime refuses with the error naming a newer one, until the release that ships it replaces `NEXT` with its version.
- ea463aa: `invariant observe` stands in front of an API, adapts nothing, and reports where its answers do not match its own specification, with no value from any response in the report. A contract can be given a deprecation and a sunset date in `invariant.yaml`, which the runtime tells that contract's callers on every answer. A JSON body is read whatever the provider called its media type, which the runtime already did.

### Patch Changes

- a136b88: A number in an adapted body now passes through exactly as it was written, unless an instruction changes it. The runtime read numbers as doubles and wrote them back the shortest way, so an integer past 2^53 was rounded (Qdrant's suite sends a search `limit` of u64::MAX, which reached the server as 18446744073709552000 and was refused) and `1.0` came out as `1` (Qdrant tells a multivector from other inputs by how its numbers are written). A body with sixteen digits in a row, a fraction ending in zero, an exponent or a negative zero now takes the exact path, in the Go engine too.
- 0823e06: A program whose `irVersion` is an object or array is refused with a `ProgramError`, not a `TypeError`.
- 80b2b43: The per-body time budget is read after every instruction as well as every 256 steps. A program shorter than that never read the clock at all, so sixty moves over nine thousand items ran for more than a second against a five millisecond budget; they are now stopped with `TimeBudgetError` as the budget says.
- @invariant-app/decimal@0.2.0
