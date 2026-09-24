# @invariant-app/diff

## 0.4.0

### Patch Changes

- cba62b1: More of what old callers are sent is explained, in shapes real APIs take. An object written in place is read field by field even where something deep inside it refers to a named schema, so Supabase's custom hostname, whose `data` holds error lists of a named value, asks about the eleven fields in it that may now be missing; and a list body names the schema it holds, so the members Supabase renamed `V1OrganizationMemberResponse_Output` are compared with what they were. A choice whose branches were given titles, as Langfuse titled its prompt's, or a value that was any value and came to name a choice, is a proved `restate`: containment now tells two branches apart where one always has a property the other never names, and takes two schemas stated alike on both sides, all the way down, as allowing the same values. A place that refers to the same schema on both sides is no longer read through on the new side alone, so PayPal's refund breakdown, named where it was written in place, drafts no amounts as newly added. A list that holds no value twice leaves out what it gained rather than folding it onto a value it may already hold. The compiler writes a field that may now be null as a union with null where the new contract does, as Mistral's library owner, and no longer makes an optional object always present when something inside it is translated, as Figma's `devStatus` read after its type gained a value. A `relax` may now list the types a value may be, where every type it was is among them: Okta's user schema attributes came to list an enum's values as text or whole numbers, drafted as that relax, a declared loss, and a `restate` that writes the choice as the new contract does. A list's plain items are compared like any field, so Twilio's lists of objects that came to hold values of any kind are declared as untyped, and an object with a list or an object that became another kind of value no longer has what it held drafted as removed. A reference written as the one part of an `allOf` is read as that reference. A list's items that pointed at a schema now gone, with nothing matched to it, are read on both sides, so Adyen's results that stopped being wrapped as `{ FraudCheckResult: ... }` are moves out of the wrapper; and a field that moved through a wrapper and may now be missing is asked about at its new place, as Datadog's `cve` was. A field new and required beside fields that went is asked about once no judge names it as one of them renamed, as Datadog's custom rule `id` is; and a field that points at another schema is compared where the schema it left holds the same fields however written, as PayPal's network transaction reference came to be built with `allOf`.
- d9ab966: Response vocabularies that grew or opened are drafted where the documents say what happened. `dropValues` now leaves each value out of a list on its way to the side whose contract does not name it, so it serves responses too: Discord listed `event_webhooks_types` as a list of no values and then twelve, and an old caller is sent the list without them, a declared loss. A value the old list held is taken out of the predicted list and one it did not is added, and the backward `drop` is the instruction runtimes already run. A field that became a choice between the values it named and any other text, as Mistral's tool `name` did, is the vocabulary opening: a `relax` with `enum: null` and a `restate` that writes the choice as the new contract does. So is a named vocabulary that stopped listing its values, as Apicurio's `ArtifactType` did, declared once at the schema. A field whose values moved between being listed in place and being a named schema's is compared by the values it holds, so Okta's custom role type, which went from `CUSTOM` alone to every role type there is, is asked about as a fold; one that stopped referring to a vocabulary that itself changed is left to that vocabulary's own Change, which already runs there. An `enumMap` reads `const: x` as the one value it lists.
- 407f319: A new op, `status {endpoint, from, to}`, for an operation that answers with another success status: Gitea 1.25 answers the creation of an Actions variable `201` where 1.24 answered `204`, and Immich 1.138 answers `204` where 1.137 answered `200` with nothing. An old caller is answered `from` wherever the operation now answers `to`, and what happens to the body is read from the two contracts: none where the old contract promised none, the body served as any body is where both carry one, and the Change refused where the old status promised a body the new one does not carry. It is exact. A success status removed is now adaptable, and the proposer drafts the op where the documents settle which status replaced which. Programs carry it as a site's `status` rules, which the TypeScript runtime, the Node binding and the Go engine's net/http middleware apply in turn to the provider's status, and which compose across a chain of releases; the response work of a release is filed under the status the provider answers with. A chain now finds each release's response work for a status as the runtime does, by the exact status, then its class, then `default`. A `move` may place a value beneath its own place, as Meilisearch's list of a rule's actions became the `pin` list of an object there, and a field of an object that declares no properties may be moved out of it. The TypeScript runtime now writes a copy of an object a `set` writes, as the Go engine always has, so a later write into one place no longer reaches every place it was written and the program itself. The proxy passes on an empty Host, HTTP/1.1's way of naming no host, where it refused it: Immich's suite sends one to see its share pages fall back to their public address. And a GET that came with a body is sent on without the length of the body it is not sent, where the provider waited for bytes that never came.
- Updated dependencies [6edee60]
- Updated dependencies [9458d83]
- Updated dependencies [cba62b1]
- Updated dependencies [d9ab966]
- Updated dependencies [407f319]
- Updated dependencies [f2f666a]
- Updated dependencies [ca7c00e]
  - @invariant-app/ir@0.4.0
  - @invariant-app/contract@0.4.0

## 0.3.0

### Patch Changes

- d781b98: A request field that no longer accepts some values old callers send is drafted rather than left as an open question: a list's items get `dropValues`, and a single value is one decision, which value that remains the one that went is sent as, with the likeliest suggested. Adyen, Plaid and PayPal retired request values this way. Where the field is used both ways, the compiler reads two old values that became one back as the value that remains, since the API can no longer produce the one that went. And a text schema whose enum is written as numbers is compared as the text they are written as: Plaid wrote its Prism versions as `type: string, enum: [4.1, 4, 3]` and a release later as text, which the differ reported as thirty-three values removed.
- Updated dependencies [e94a03b]
- Updated dependencies [0036e1f]
- Updated dependencies [4d37d14]
  - @invariant-app/contract@0.3.0
  - @invariant-app/ir@0.3.0

## 0.2.0

### Minor Changes

- 4f55bba: The release gate explains more of what real APIs do.
  
  - Two spellings of one schema are no longer a breaking change: `const: x` and `enum: [x]`, and a list of values written in place or as a named schema, compare as the same before the differ runs.
  - A schema renamed or written out in place where it was used is matched through the property that refers to it, so the fields it lost are drafted instead of reported with nothing to explain them.
  - A field dropped beside fields that were added is drafted as dropped, for explicit review, where no judge would pair it with one of them.
  - `remove` may leave out `restore`: old callers' requests drop the field and their responses are left without it, which the compiler allows only where their contract never promised it.
- e4f8878: A response field that took a list of values where it allowed any value before is no longer reported as breaking: the differ's "enum value added" entries for it are dropped, found through properties, list items and union branches of the old document.
- d712bcf: A value that stopped stating its list of values or its type is declared with `relax` (`enum: null`, `type: null`) where old callers are sent it, and is no longer reported at all where only their requests carry it. `const: x` is read as a one-value list, and a field that stopped referring to a named list is seen as changed.

### Patch Changes

- a530d28: A new codec, `dropValues {values}`, for a list whose items no longer accept some values an old caller may send: the values are left out of the list on the way in and the rest is served, a loss the Change declares. Asana took a hundred and twenty-six fields out of what a portfolio's items may be asked to include, and an old caller asking for `opt_fields=color` was refused outright; the proposer now drafts this for a list parameter whose values only went, and asks where others arrived beside them. Runtimes run it as the new `drop` instruction, in the Go engine too. A feature added since the last release is now entered as `NEXT` and asks for a pre-release of the next patch, which every published runtime refuses with the error naming a newer one, until the release that ships it replaces `NEXT` with its version.
- 7c44320: An empty `enum`, `oneOf` or `anyOf` is read as no list at all, and a union of constants typed once on the union, or with a single branch, or beside a `format`, is read as the enum it is. A response field reached through a map's values that took a list of values is no longer reported as breaking.
- 7c44320: A request property that moved into every variant of a choice is no longer reported as removed, and a schema that became a choice is only left undrafted where the variants hold what it lost.
- 48948ea: A new op, `restate {path}`, says the new contract describes the same values another way, such as one object split into a `oneOf` of its kinds. Nothing is transformed and nothing is lost, so the Change stays exact, and the compiler takes it only once it proves, schema against schema, that nothing old callers may now be sent was ruled out for them and nothing they send is refused. `covers` in `@invariant-app/contract` is that proof, and it reads a `discriminator`'s property as required in every branch, as OpenAPI does. The proposer drafts a restatement wherever how a choice is written changed and the proof holds, and leaves out the drafts it makes unnecessary. Figma rewrote a node's `Effect` this way, which left sixty-odd places unexplained in one release.
- 9ee5787: A differ run that lists values in a different order no longer reads as a different answer. oasdiff writes the values a change added or removed in the order it walked a Go map and hashes that text into its fingerprint, so Figma's discriminator mappings came back as `NOISE, TEXTURE` and then `TEXTURE, NOISE`, and a confirmed comparison of two identical answers was refused as not reproducible. Lists in an entry's text are sorted, and its fingerprint is taken from what it says.
- e5723a1: A way to authenticate that names a security scheme the document never declares is left out before comparing, so removing it is no longer reported as breaking.
- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [7c44320]
- Updated dependencies [2e2c416]
- Updated dependencies [ea463aa]
- Updated dependencies [1e2171a]
- Updated dependencies [80b2b43]
- Updated dependencies [a136b88]
- Updated dependencies [48948ea]
- Updated dependencies [d712bcf]
  - @invariant-app/ir@0.2.0
  - @invariant-app/contract@0.2.0
