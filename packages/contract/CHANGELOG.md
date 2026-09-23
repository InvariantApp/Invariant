# @invariant-app/contract

## 0.3.0

### Patch Changes

- e94a03b: A choice whose every branch is the same kind of value is that kind, so a schema reached through null or a choice of objects, as Meilisearch's task `network` is, is served inside it rather than refused as a union nothing tells apart.
- 0036e1f: A union of a schema and a branch that says nothing but `nullable: true`, which is how schemars and utoipa write an optional value in OpenAPI 3.0, is read as the schema or null, so a Change to the schema is served inside it rather than refused as a union nothing tells apart. A branch beside nothing but null carries no guard at all, since no instruction acts on a null; guarding each one nested Qdrant's telemetry deeper than a program may.
- 4d37d14: A Swagger 2.0 response that names a definition where a response belongs, as Gitea's runner listings do, is upgraded as a response whose body is that definition. Upgraded as written, it named a schema where a response belongs and the differ refused the whole document.
- @invariant-app/ir@0.3.0

## 0.2.0

### Minor Changes

- 7c44320: An empty `enum`, `oneOf` or `anyOf` is read as no list at all, and a union of constants typed once on the union, or with a single branch, or beside a `format`, is read as the enum it is. A response field reached through a map's values that took a list of values is no longer reported as breaking.
- 2e2c416: A schema that lists its properties and states no type is read as the object it describes, so a release that finally writes `type: object` is not reported as changing the type of every field that holds one.
- ea463aa: `invariant observe` stands in front of an API, adapts nothing, and reports where its answers do not match its own specification, with no value from any response in the report. A contract can be given a deprecation and a sunset date in `invariant.yaml`, which the runtime tells that contract's callers on every answer. A JSON body is read whatever the provider called its media type, which the runtime already did.
- 48948ea: A new op, `restate {path}`, says the new contract describes the same values another way, such as one object split into a `oneOf` of its kinds. Nothing is transformed and nothing is lost, so the Change stays exact, and the compiler takes it only once it proves, schema against schema, that nothing old callers may now be sent was ruled out for them and nothing they send is refused. `covers` in `@invariant-app/contract` is that proof, and it reads a `discriminator`'s property as required in every branch, as OpenAPI does. The proposer drafts a restatement wherever how a choice is written changed and the proof holds, and leaves out the drafts it makes unnecessary. Figma rewrote a node's `Effect` this way, which left sixty-odd places unexplained in one release.

### Patch Changes

- 80b2b43: Three ways a specification could make the reader see something it did not say are closed. A `$ref` to a file committed as a link to somewhere outside the repository is refused, where it used to be followed wherever the link pointed. A reference is resolved only through what the document itself holds, so `#/components/schemas/__proto__` or `.../constructor` no longer resolves to a JavaScript prototype and counts as defined. And a schema gathered from a file named `__proto__` is placed under a name of its own rather than lost. Separately, a schema that sits at more than 10,000 places is served by blocks that follow the value, as a recursive one is, instead of each place being listed: a few kilobytes of references that double at each level wrote a program that doubled with them, and sixteen levels ended the compiler with a stack overflow.
- a136b88: A restatement is written into the prediction exactly as the new contract writes it, with its names, and is refused where it refers to a schema the old contract states differently, since written there it would mean the old statement rather than what was proved. Plaid's account identity re-declares its base's mask in an `allOf`, and merged here it was reconciled differently from how the differ reads it, leaving fifty-odd places that became nullable in a release where none had. `referencesAlike` in `@invariant-app/contract` is the check. The proposer also no longer restates a place whose choices changed only in their descriptions.
- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [ea463aa]
- Updated dependencies [1e2171a]
- Updated dependencies [48948ea]
- Updated dependencies [d712bcf]
  - @invariant-app/ir@0.2.0
