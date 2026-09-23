# @invariant-app/verifier

## 0.3.0

### Patch Changes

- 782ec22: Generated values stay inside what their schema allows, and generation finishes. An integer bounded past what a double holds exactly, as every 64-bit column drf-spectacular and Java APIs describe is, made the generator draw forever: the gate on NetBox 3.6 outlasted a two and a half hour job without finishing its laws, and now takes seconds. An enum value the schema's own type rules out, such as the null drf-spectacular lists beside `type: string` on every choice field, is no longer drawn, so the laws stop blaming a release's Changes for a value its contract never allowed.
- 0036e1f: The lens laws check only the directions a schema travels. A field added to a schema only responses carry, drafted with no value because no request ever needs one, is no longer refused for what the request half would do to a request that cannot exist.
- e2168b7: The lens laws no longer refuse a `relax` for the values it declares it lets through. A relax runs nothing, so it was never counted as touching its schema: the values outside the old bounds it passes on were reported as a round trip failure of no Change at all, as Qdrant 1.18's lowered `max_query_limit` minimum was. A value outside the other contract's bounds at the relaxed place is now the loss that Change names, and anything else it breaks is still caught.
- 0036e1f: Checking a value against an OpenAPI 3.0 contract allows null where the schema says `nullable: true`. The lens laws generated such nulls and then refused them, which blocked any Change touching a schema with a nullable field.
- ac59d08: A decided fold on a vocabulary that is a schema of its own passes the lens laws: its values are checked inside a body, as every field holding one carries them, rather than as a whole body the runtime has nowhere to write back into. Where such a value really is a whole response or request body, the compiler now refuses the Change there instead of shipping a translation the runtime silently skips.
- Updated dependencies [e94a03b]
- Updated dependencies [0036e1f]
- Updated dependencies [9dc889d]
- Updated dependencies [e2168b7]
- Updated dependencies [d781b98]
- Updated dependencies [4d37d14]
- Updated dependencies [ac59d08]
  - @invariant-app/contract@0.3.0
  - @invariant-app/runtime@0.3.0
  - @invariant-app/compiler@0.3.0
  - @invariant-app/diff@0.3.0
  - @invariant-app/decimal@0.3.0
  - @invariant-app/ir@0.3.0

## 0.2.0

### Minor Changes

- ea463aa: `invariant observe` stands in front of an API, adapts nothing, and reports where its answers do not match its own specification, with no value from any response in the report. A contract can be given a deprecation and a sunset date in `invariant.yaml`, which the runtime tells that contract's callers on every answer. A JSON body is read whatever the provider called its media type, which the runtime already did.

### Patch Changes

- Updated dependencies [a136b88]
- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [7c44320]
- Updated dependencies [0823e06]
- Updated dependencies [fad78f7]
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
- Updated dependencies [80b2b43]
- Updated dependencies [e5723a1]
- Updated dependencies [d712bcf]
- Updated dependencies [fad78f7]
  - @invariant-app/runtime@0.2.0
  - @invariant-app/diff@0.2.0
  - @invariant-app/compiler@0.2.0
  - @invariant-app/ir@0.2.0
  - @invariant-app/contract@0.2.0
  - @invariant-app/decimal@0.2.0
