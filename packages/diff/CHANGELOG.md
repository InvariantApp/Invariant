# @invariant-app/diff

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
