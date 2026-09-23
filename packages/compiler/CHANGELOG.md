# @invariant-app/compiler

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
