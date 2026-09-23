# @invariant-app/runtime

## 0.2.0

### Minor Changes

- a530d28: A new codec, `dropValues {values}`, for a list whose items no longer accept some values an old caller may send: the values are left out of the list on the way in and the rest is served, a loss the Change declares. Asana took a hundred and twenty-six fields out of what a portfolio's items may be asked to include, and an old caller asking for `opt_fields=color` was refused outright; the proposer now drafts this for a list parameter whose values only went, and asks where others arrived beside them. Runtimes run it as the new `drop` instruction, in the Go engine too. A feature added since the last release is now entered as `NEXT` and asks for a pre-release of the next patch, which every published runtime refuses with the error naming a newer one, until the release that ships it replaces `NEXT` with its version.
- ea463aa: `invariant observe` stands in front of an API, adapts nothing, and reports where its answers do not match its own specification, with no value from any response in the report. A contract can be given a deprecation and a sunset date in `invariant.yaml`, which the runtime tells that contract's callers on every answer. A JSON body is read whatever the provider called its media type, which the runtime already did.

### Patch Changes

- a136b88: A number in an adapted body now passes through exactly as it was written, unless an instruction changes it. The runtime read numbers as doubles and wrote them back the shortest way, so an integer past 2^53 was rounded (Qdrant's suite sends a search `limit` of u64::MAX, which reached the server as 18446744073709552000 and was refused) and `1.0` came out as `1` (Qdrant tells a multivector from other inputs by how its numbers are written). A body with sixteen digits in a row, a fraction ending in zero, an exponent or a negative zero now takes the exact path, in the Go engine too.
- 0823e06: A program whose `irVersion` is an object or array is refused with a `ProgramError`, not a `TypeError`.
- 80b2b43: The per-body time budget is read after every instruction as well as every 256 steps. A program shorter than that never read the clock at all, so sixty moves over nine thousand items ran for more than a second against a five millisecond budget; they are now stopped with `TimeBudgetError` as the budget says.
- @invariant-app/decimal@0.2.0
