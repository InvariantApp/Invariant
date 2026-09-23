# @invariant-app/migrate-core

## 0.3.0

### Patch Changes

- @invariant-app/ir@0.3.0

## 0.2.0

### Minor Changes

- 9302f20: A migration language pack for Go. A small helper built on `go/packages` and `go/types` finds every reference to an SDK by the object it resolves to, reads fields by the wire name their `json` tag gives them, and reads the API operations go-github's methods say they call. The pack moves imports to the SDK's new major version, rewrites what a Change or the SDK itself renamed exactly, rewrites calls to what the new release marks `//go:fix inline` into what they do (go-github's `String(v)` into `Ptr(v)`, with the type argument spelled out where an untyped constant needs it), and type-checks the result against the new release with go.mod moved in a copy. Whatever still does not compile is shown to a person together with everything it reaches: where a value a call no longer takes was made, and the consumer's own wrappers, interfaces, other implementations and callers that pass it on, including through a method the SDK replaced with one that calls the same operation. The go toolchain runs with `GOTOOLCHAIN=local`, `-mod=readonly`, no cgo and modules only through the proxy, and the consumer's code, tests and generators are never run.
  
  `@invariant-app/migrate-core` gains `Offsets`, which converts between the UTF-8 byte offsets a compiler reports and the string offsets an edit applies at.
- 7aa6dbe: Python consumers can be migrated. `@invariant-app/migrate-py` reads a Python repository against the SDK release it uses today, through pyright for what each name refers to and tree-sitter for what the code does with it, and writes the edits the Changes determine: a renamed field wherever it is read, set, passed by keyword or written as a key the type checker ties to the SDK, and a renamed value where a field is compared with it. A removed field, a subscript or `.get()` by a field's name, a read the checker cannot type, an expansion (`expand=["latest_invoice.payment_intent"]`) through a removed field and every API version pin (`stripe.api_version`, `stripe_version=`) are reported to a person, never edited. The result is then checked against the release being moved to, and every place that stops type-checking is reported with the checker's words, whether or not a Change named it, including a `match` a newly added value leaves incomplete and the consumer's own copy of values the SDK widened.
  
  The SDK and what its metadata requires are installed from wheels only, unpacked and checked against the digest the index publishes; a release with no wheel is refused rather than built. pyright is never pointed at an interpreter, so nothing of the consumer's, and no Python at all, is run.
  
  `@invariant-app/migrate-core` holds what every language pack shares: the migration plan, byte-range edits, the sites shown to a person and how a re-encoding is described. `@invariant-app/migrate-ts` re-exports them, so nothing that imports them from there changes.

### Patch Changes

- a530d28: A new codec, `dropValues {values}`, for a list whose items no longer accept some values an old caller may send: the values are left out of the list on the way in and the rest is served, a loss the Change declares. Asana took a hundred and twenty-six fields out of what a portfolio's items may be asked to include, and an old caller asking for `opt_fields=color` was refused outright; the proposer now drafts this for a list parameter whose values only went, and asks where others arrived beside them. Runtimes run it as the new `drop` instruction, in the Go engine too. A feature added since the last release is now entered as `NEXT` and asks for a pre-release of the next patch, which every published runtime refuses with the error naming a newer one, until the release that ships it replaces `NEXT` with its version.
- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [ea463aa]
- Updated dependencies [1e2171a]
- Updated dependencies [48948ea]
- Updated dependencies [d712bcf]
  - @invariant-app/ir@0.2.0
