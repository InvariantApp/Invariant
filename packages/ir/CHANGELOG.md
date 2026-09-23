# @invariant-app/ir

## 0.2.0

### Minor Changes

- 4f55bba: The release gate explains more of what real APIs do.
  
  - Two spellings of one schema are no longer a breaking change: `const: x` and `enum: [x]`, and a list of values written in place or as a named schema, compare as the same before the differ runs.
  - A schema renamed or written out in place where it was used is matched through the property that refers to it, so the fields it lost are drafted instead of reported with nothing to explain them.
  - A field dropped beside fields that were added is drafted as dropped, for explicit review, where no judge would pair it with one of them.
  - `remove` may leave out `restore`: old callers' requests drop the field and their responses are left without it, which the compiler allows only where their contract never promised it.
- a530d28: A new codec, `dropValues {values}`, for a list whose items no longer accept some values an old caller may send: the values are left out of the list on the way in and the rest is served, a loss the Change declares. Asana took a hundred and twenty-six fields out of what a portfolio's items may be asked to include, and an old caller asking for `opt_fields=color` was refused outright; the proposer now drafts this for a list parameter whose values only went, and asks where others arrived beside them. Runtimes run it as the new `drop` instruction, in the Go engine too. A feature added since the last release is now entered as `NEXT` and asks for a pre-release of the next patch, which every published runtime refuses with the error naming a newer one, until the release that ships it replaces `NEXT` with its version.
- ea463aa: `invariant observe` stands in front of an API, adapts nothing, and reports where its answers do not match its own specification, with no value from any response in the report. A contract can be given a deprecation and a sunset date in `invariant.yaml`, which the runtime tells that contract's callers on every answer. A JSON body is read whatever the provider called its media type, which the runtime already did.
- 48948ea: A new op, `restate {path}`, says the new contract describes the same values another way, such as one object split into a `oneOf` of its kinds. Nothing is transformed and nothing is lost, so the Change stays exact, and the compiler takes it only once it proves, schema against schema, that nothing old callers may now be sent was ruled out for them and nothing they send is refused. `covers` in `@invariant-app/contract` is that proof, and it reads a `discriminator`'s property as required in every branch, as OpenAPI does. The proposer drafts a restatement wherever how a choice is written changed and the proof holds, and leaves out the drafts it makes unnecessary. Figma rewrote a node's `Effect` this way, which left sixty-odd places unexplained in one release.
- d712bcf: A value that stopped stating its list of values or its type is declared with `relax` (`enum: null`, `type: null`) where old callers are sent it, and is no longer reported at all where only their requests carry it. `const: x` is read as a one-value list, and a field that stopped referring to a named list is seen as changed.

### Patch Changes

- 1e2171a: An operation whose response now names a different schema is compared with that schema and drafted against that response alone, which the compiler now serves for a body that is a named schema, leaving every other operation the schema serves as it was.
