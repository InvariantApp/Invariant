# @invariant-app/compiler

## 0.5.0

### Minor Changes

- 353f443: `invariant check` fits in memory on Stripe-sized specifications. The lens laws built the generator for a schema in full before drawing a value, one generator for every path through the schemas it reaches, and where nearly every object reaches nearly every other, as Stripe's do through expandable fields, that ran out of a 12 GB heap. A schema's generator is now built the first time a value is drawn from it, and one schema reached along many paths shares one generator per depth. The values drawn, and their shrinks, are the same as before.
  
  The lens laws also finish in reasonable time there. Declared losses are parsed once per schema and removed in one walk, the release's shared blocks are compiled once rather than for every schema, and a law that fails tries at most a thousand smaller values before reporting the smallest it found, saying so when a smaller one may exist. A law on one Stripe object had been shrinking a 1.6 MB value for an hour and a half.
  
  `schemaLenses` returns the lens of any schema of one release, compiling the release's shared blocks once; `schemaLens` is the same for one schema.

### Patch Changes

- 2ab33a0: A value a Change puts back or fills in (`remove` with `restore`, `default`,
  and the value `add` gives an old caller's request) is now written only where
  the object the Change is scoped to is there. It used to create every object
  on the way that was missing, so an answer that left out an optional object
  reached an old caller with one holding only the restored field, where the
  old server had sent no object at all.
- Updated dependencies [0672745]
- Updated dependencies [eeeb512]
- Updated dependencies [268385d]
  - @invariant-app/diff@0.5.0
  - @invariant-app/runtime@0.5.0
  - @invariant-app/contract@0.5.0
  - @invariant-app/decimal@0.5.0
  - @invariant-app/ir@0.5.0

## 0.4.0

### Minor Changes

- cba62b1: More of what old callers are sent is explained, in shapes real APIs take. An object written in place is read field by field even where something deep inside it refers to a named schema, so Supabase's custom hostname, whose `data` holds error lists of a named value, asks about the eleven fields in it that may now be missing; and a list body names the schema it holds, so the members Supabase renamed `V1OrganizationMemberResponse_Output` are compared with what they were. A choice whose branches were given titles, as Langfuse titled its prompt's, or a value that was any value and came to name a choice, is a proved `restate`: containment now tells two branches apart where one always has a property the other never names, and takes two schemas stated alike on both sides, all the way down, as allowing the same values. A place that refers to the same schema on both sides is no longer read through on the new side alone, so PayPal's refund breakdown, named where it was written in place, drafts no amounts as newly added. A list that holds no value twice leaves out what it gained rather than folding it onto a value it may already hold. The compiler writes a field that may now be null as a union with null where the new contract does, as Mistral's library owner, and no longer makes an optional object always present when something inside it is translated, as Figma's `devStatus` read after its type gained a value. A `relax` may now list the types a value may be, where every type it was is among them: Okta's user schema attributes came to list an enum's values as text or whole numbers, drafted as that relax, a declared loss, and a `restate` that writes the choice as the new contract does. A list's plain items are compared like any field, so Twilio's lists of objects that came to hold values of any kind are declared as untyped, and an object with a list or an object that became another kind of value no longer has what it held drafted as removed. A reference written as the one part of an `allOf` is read as that reference. A list's items that pointed at a schema now gone, with nothing matched to it, are read on both sides, so Adyen's results that stopped being wrapped as `{ FraudCheckResult: ... }` are moves out of the wrapper; and a field that moved through a wrapper and may now be missing is asked about at its new place, as Datadog's `cve` was. A field new and required beside fields that went is asked about once no judge names it as one of them renamed, as Datadog's custom rule `id` is; and a field that points at another schema is compared where the schema it left holds the same fields however written, as PayPal's network transaction reference came to be built with `allOf`.
- d9ab966: Response vocabularies that grew or opened are drafted where the documents say what happened. `dropValues` now leaves each value out of a list on its way to the side whose contract does not name it, so it serves responses too: Discord listed `event_webhooks_types` as a list of no values and then twelve, and an old caller is sent the list without them, a declared loss. A value the old list held is taken out of the predicted list and one it did not is added, and the backward `drop` is the instruction runtimes already run. A field that became a choice between the values it named and any other text, as Mistral's tool `name` did, is the vocabulary opening: a `relax` with `enum: null` and a `restate` that writes the choice as the new contract does. So is a named vocabulary that stopped listing its values, as Apicurio's `ArtifactType` did, declared once at the schema. A field whose values moved between being listed in place and being a named schema's is compared by the values it holds, so Okta's custom role type, which went from `CUSTOM` alone to every role type there is, is asked about as a fold; one that stopped referring to a vocabulary that itself changed is left to that vocabulary's own Change, which already runs there. An `enumMap` reads `const: x` as the one value it lists.
- 407f319: A new op, `status {endpoint, from, to}`, for an operation that answers with another success status: Gitea 1.25 answers the creation of an Actions variable `201` where 1.24 answered `204`, and Immich 1.138 answers `204` where 1.137 answered `200` with nothing. An old caller is answered `from` wherever the operation now answers `to`, and what happens to the body is read from the two contracts: none where the old contract promised none, the body served as any body is where both carry one, and the Change refused where the old status promised a body the new one does not carry. It is exact. A success status removed is now adaptable, and the proposer drafts the op where the documents settle which status replaced which. Programs carry it as a site's `status` rules, which the TypeScript runtime, the Node binding and the Go engine's net/http middleware apply in turn to the provider's status, and which compose across a chain of releases; the response work of a release is filed under the status the provider answers with. A chain now finds each release's response work for a status as the runtime does, by the exact status, then its class, then `default`. A `move` may place a value beneath its own place, as Meilisearch's list of a rule's actions became the `pin` list of an object there, and a field of an object that declares no properties may be moved out of it. The TypeScript runtime now writes a copy of an object a `set` writes, as the Go engine always has, so a later write into one place no longer reaches every place it was written and the program itself. The proxy passes on an empty Host, HTTP/1.1's way of naming no host, where it refused it: Immich's suite sends one to see its share pages fall back to their public address. And a GET that came with a body is sent on without the length of the body it is not sent, where the provider waited for bytes that never came.
- f2f666a: The last places left on pairs that were otherwise explained. A parameter is asked about as a body field is: which accepted value each one old callers may send that went is sent as, as Sentry's release `sort` and Supabase's `desired_instance_size` lost values, and what old callers send for a parameter that became required or arrived required with no default, as Asana's `workspace`; a parameter whose values are a named schema's is still left to that schema. A value only old callers send that lost values as others arrived is asked about the same way, with the new ones among the answers, as Plaid's processor token stopped taking `paynote`. A body that is a list written in place is compared by its items, as Sentry's dashboards came to carry `isHidden`, and a map of plain values by its values, so a value that may now be null is served as the map without it, as Figma's rendered images. A value written differently that provably holds the same values is a `restate`: PayPal's JSON patch `value` went from a choice of every type, to a value that states no type, to a list of every type, and containment now reads each of those as any value, and `password` as the hint to a form it is, as CloudFront's comments came to state; toward old callers the values have to be the same both ways, so a response that can no longer hold something is still declared. Null said with 3.0's flag in a 3.1 document and later with a list of types is a restatement too, and the prediction writes a field that may now be null as the new contract says it, as Resend's attachments. A pattern or format replaced by one nothing can compare it with is declared with a `relax` on a response, as Twilio's phone number `capabilities`. A `widen` may name a branch written out in the union itself by a reference to where it is written, and the compiler tells it apart and writes it in place: Supabase's upgrade eligibility lists blockers as a `oneOf` written into the list, and a kind added there is left out of old callers' list. A field that says nothing of its kind is no longer read as never null, so PayPal's patch `value` is not given a `dropNull` that would have dropped an old caller's null.
- ca7c00e: XML bodies are served. Amazon's CloudFront and CloudSearch declare every body as `text/xml`, and every Change to them was left unexplained because nothing read XML. The contract now reads an operation's XML body where it has no JSON one, so the proposer drafts for it and the prediction checks it as it does JSON; the compiler describes each XML body a site has work for, from the schema's OpenAPI `xml` object (element or attribute, wrapped or not, names, namespaces and what each place holds), as a site's `xml` program, a new program feature that asks for the next runtime; and the TypeScript runtime, the Node binding and the Go engine with its net/http middleware decode such a body into a tree, run the same instructions and write it back. Only the places the program names are decoded: every other element, and everything between elements, is written back exactly as it came, so a document nothing changed comes out byte for byte. The parser is written for hostile input: a document type declaration is refused, so no entity is expanded and nothing external is read, and nesting and namespace declarations are capped. What cannot be written back exactly is refused rather than guessed at: text among an object's elements, attributes on a value, an encoding other than UTF-8, and, at compile time, a map, a schema that contains itself, or a value read whose schema says nothing of it, which the release gate blocks. A program that reaches a parameter and an XML body at once is served too, as one with a form body is. A restatement of a whole body is no longer refused as a value with nowhere to be written back, since it writes nothing: CloudSearch restates each request body whole. The proposer also no longer asks a vocabulary decision where a case codec already serves the field, as Adyen's `Active` becoming `active`.

### Patch Changes

- 6edee60: A program whose `move` places a value beneath its own place now asks for the runtime that can run it, so runtime 0.3.0 refuses it at load instead of failing at the first request. And `relax` with a list of types reads a value written as a choice of nothing but types, such as Mistral's `anyOf: [integer, null]`, as those types, where it had drafted a Change that could not compile.
- 5da65b3: Tests only: the status test holds before and after a release writes its version in, and the numeric fidelity benchmark asserts which parse each mode takes rather than which of two timings came out lower.
- 9458d83: What old callers send is explained in three more shapes real APIs take. A place that referred to a named schema and now writes an object out in its place is compared as what that schema held, less what the schema's own comparison already drafts: PayPal's phone number, written out inside `phone_with_type`, no longer reads as a newly required national number, and a shipping name that kept only `full_name` loses its given name and surname there alone. A named schema written out differently at each place it was used is compared place by place instead of with the first, so the shipping name keeps the `full_name` a payer's name dropped. A request body that named a schema and is now written in place, or names another while the old one stays, is compared with the schema it named, scoped to the operation, as Okta's group creation now takes a profile alone. A format stated where the declared bounds already kept every value inside it is drafted as a `restate`, on a parameter as on a field, as Twilio's `PageSize` gained `int64` beside bounds of 1 and 1000; containment now reads `int32` and `int64` as the ranges they are, so an unbounded integer that comes to state one is no longer proved unchanged. And the compiler predicts a field that may now be missing or null for old callers in their responses alone where they also send the schema, so Adyen's `supportUrl`, optional where a payment method is returned and required where one is set up, no longer reads as newly required in requests.
- Updated dependencies [6edee60]
- Updated dependencies [5da65b3]
- Updated dependencies [9458d83]
- Updated dependencies [cba62b1]
- Updated dependencies [d9ab966]
- Updated dependencies [407f319]
- Updated dependencies [f2f666a]
- Updated dependencies [ca7c00e]
  - @invariant-app/ir@0.4.0
  - @invariant-app/runtime@0.4.0
  - @invariant-app/contract@0.4.0
  - @invariant-app/diff@0.4.0
  - @invariant-app/decimal@0.4.0

## 0.3.0

### Patch Changes

- e2168b7: The lens laws no longer refuse a `relax` for the values it declares it lets through. A relax runs nothing, so it was never counted as touching its schema: the values outside the old bounds it passes on were reported as a round trip failure of no Change at all, as Qdrant 1.18's lowered `max_query_limit` minimum was. A value outside the other contract's bounds at the relaxed place is now the loss that Change names, and anything else it breaks is still caught.
- d781b98: A request field that no longer accepts some values old callers send is drafted rather than left as an open question: a list's items get `dropValues`, and a single value is one decision, which value that remains the one that went is sent as, with the likeliest suggested. Adyen, Plaid and PayPal retired request values this way. Where the field is used both ways, the compiler reads two old values that became one back as the value that remains, since the API can no longer produce the one that went. And a text schema whose enum is written as numbers is compared as the text they are written as: Plaid wrote its Prism versions as `type: string, enum: [4.1, 4, 3]` and a release later as text, which the differ reported as thirty-three values removed.
- ac59d08: A decided fold on a vocabulary that is a schema of its own passes the lens laws: its values are checked inside a body, as every field holding one carries them, rather than as a whole body the runtime has nowhere to write back into. Where such a value really is a whole response or request body, the compiler now refuses the Change there instead of shipping a translation the runtime silently skips.
- Updated dependencies [e94a03b]
- Updated dependencies [0036e1f]
- Updated dependencies [9dc889d]
- Updated dependencies [d781b98]
- Updated dependencies [4d37d14]
  - @invariant-app/contract@0.3.0
  - @invariant-app/runtime@0.3.0
  - @invariant-app/diff@0.3.0
  - @invariant-app/decimal@0.3.0
  - @invariant-app/ir@0.3.0

## 0.2.0

### Minor Changes

- 4f55bba: The release gate explains more of what real APIs do.
  
  - Two spellings of one schema are no longer a breaking change: `const: x` and `enum: [x]`, and a list of values written in place or as a named schema, compare as the same before the differ runs.
  - A schema renamed or written out in place where it was used is matched through the property that refers to it, so the fields it lost are drafted instead of reported with nothing to explain them.
  - A field dropped beside fields that were added is drafted as dropped, for explicit review, where no judge would pair it with one of them.
  - `remove` may leave out `restore`: old callers' requests drop the field and their responses are left without it, which the compiler allows only where their contract never promised it.
- a530d28: A new codec, `dropValues {values}`, for a list whose items no longer accept some values an old caller may send: the values are left out of the list on the way in and the rest is served, a loss the Change declares. Asana took a hundred and twenty-six fields out of what a portfolio's items may be asked to include, and an old caller asking for `opt_fields=color` was refused outright; the proposer now drafts this for a list parameter whose values only went, and asks where others arrived beside them. Runtimes run it as the new `drop` instruction, in the Go engine too. A feature added since the last release is now entered as `NEXT` and asks for a pre-release of the next patch, which every published runtime refuses with the error naming a newer one, until the release that ships it replaces `NEXT` with its version.
- ea463aa: `invariant observe` stands in front of an API, adapts nothing, and reports where its answers do not match its own specification, with no value from any response in the report. A contract can be given a deprecation and a sunset date in `invariant.yaml`, which the runtime tells that contract's callers on every answer. A JSON body is read whatever the provider called its media type, which the runtime already did.
- 1e2171a: An operation whose response now names a different schema is compared with that schema and drafted against that response alone, which the compiler now serves for a body that is a named schema, leaving every other operation the schema serves as it was.
- 48948ea: A new op, `restate {path}`, says the new contract describes the same values another way, such as one object split into a `oneOf` of its kinds. Nothing is transformed and nothing is lost, so the Change stays exact, and the compiler takes it only once it proves, schema against schema, that nothing old callers may now be sent was ruled out for them and nothing they send is refused. `covers` in `@invariant-app/contract` is that proof, and it reads a `discriminator`'s property as required in every branch, as OpenAPI does. The proposer drafts a restatement wherever how a choice is written changed and the proof holds, and leaves out the drafts it makes unnecessary. Figma rewrote a node's `Effect` this way, which left sixty-odd places unexplained in one release.
- d712bcf: A value that stopped stating its list of values or its type is declared with `relax` (`enum: null`, `type: null`) where old callers are sent it, and is no longer reported at all where only their requests carry it. `const: x` is read as a one-value list, and a field that stopped referring to a named list is seen as changed.

### Patch Changes

- fad78f7: A response-scoped Change to what a list holds is served rather than refused: the prediction walks into a list's items and a map's values, as the pointer layer that runs it always has.
- a136b88: A restatement is written into the prediction exactly as the new contract writes it, with its names, and is refused where it refers to a schema the old contract states differently, since written there it would mean the old statement rather than what was proved. Plaid's account identity re-declares its base's mask in an `allOf`, and merged here it was reconciled differently from how the differ reads it, leaving fifty-odd places that became nullable in a release where none had. `referencesAlike` in `@invariant-app/contract` is the check. The proposer also no longer restates a place whose choices changed only in their descriptions.
- 80b2b43: A Change whose pointer names `__proto__`, `constructor` or `prototype` is refused when it is compiled. The runtime refuses a program that names one when it loads it, and `prototype` compiled without a word, so the release gate passed and the program failed only on deploy.
- fad78f7: A Change that adds or removes a list's items, or a map's values, is refused rather than served. Both compiled to writing or deleting what the pointer named, which at a wildcard is every item of the list, so an old caller's list arrived empty while the predicted document matched the new contract and closure called it explained. A list that gained a kind of item is a `widen`; one that lost a kind is a declared loss.
- Updated dependencies [a136b88]
- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [7c44320]
- Updated dependencies [0823e06]
- Updated dependencies [7c44320]
- Updated dependencies [e4f8878]
- Updated dependencies [2e2c416]
- Updated dependencies [ea463aa]
- Updated dependencies [1e2171a]
- Updated dependencies [80b2b43]
- Updated dependencies [a136b88]
- Updated dependencies [48948ea]
- Updated dependencies [9ee5787]
- Updated dependencies [80b2b43]
- Updated dependencies [e5723a1]
- Updated dependencies [d712bcf]
  - @invariant-app/runtime@0.2.0
  - @invariant-app/diff@0.2.0
  - @invariant-app/ir@0.2.0
  - @invariant-app/contract@0.2.0
  - @invariant-app/decimal@0.2.0
