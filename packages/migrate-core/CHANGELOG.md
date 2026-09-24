# @invariant-app/migrate-core

## 0.4.0

### Minor Changes

- c6d1cac: A fixture nothing types is read as the schema it says it is. Stripe tags every object it sends with its type, `"object": "invoice"`, and a recorded webhook or a test's stand-in copies the tag with everything else; given `tags` in the symbol map, every pack now shows a person each entry of such a literal that a Change removed or moved from its schema, and each event recorded at the API version the consumer's SDK spoke before the upgrade (its `api_version`), which the upgrade moves; one recorded long before was left behind already, and is not shown. The literal is read the same way in every language, as JSON in a Go raw string, a Python dictionary or a TypeScript object, and is never rewritten: what a fixture should hold instead is the API's answer, not an edit of the old one. `taggedObjectSites` and `goneFields` are exported from `@invariant-app/migrate-core` for a pack of its own.
- 1ba578b: The TypeScript pack checks the migrated consumer against the release it moves to, as the Python and Go packs do. Given `upgraded`, where the new release resolves from, it type-checks the consumer's files as they were against the release used today and as the edits left them against the new one, and shows a person each error the upgrade brought, with the checker's own words and the whole statement it is in: a field the new API version no longer sends, a parameter a method stopped taking, a fixture that no longer fits the type it claims. JavaScript is checked the same way, as `checkJs` would, and only what is new is reported. `checkFor` bounds the check in time where the type checker offers to stop, and `checker` runs each check where the caller can stop it outright, such as in a worker it ends at the deadline; a file the check did not reach is listed in the result's `unchecked` rather than holding the migration, and `trace` is told each step as it finishes. The engine itself still starts no process and no thread. `originalOffset`, which places an error in the edited text back where it was read, moves to `@invariant-app/migrate-core` for every pack, and is still exported from `@invariant-app/migrate-py`.
  
  A field a Change moved or removed is also shown where only its name says it may be the contract's: a key of an object literal nothing types, as a test's stand-in for a subscription handed to a mock, or a read or subscript of a value typed `any`, as a webhook's payload. Such a place is never rewritten, as the Python pack does with a dictionary's keys; a use typed as anything else is the checker's to decide.

### Patch Changes

- d9ab966: Response vocabularies that grew or opened are drafted where the documents say what happened. `dropValues` now leaves each value out of a list on its way to the side whose contract does not name it, so it serves responses too: Discord listed `event_webhooks_types` as a list of no values and then twelve, and an old caller is sent the list without them, a declared loss. A value the old list held is taken out of the predicted list and one it did not is added, and the backward `drop` is the instruction runtimes already run. A field that became a choice between the values it named and any other text, as Mistral's tool `name` did, is the vocabulary opening: a `relax` with `enum: null` and a `restate` that writes the choice as the new contract does. So is a named vocabulary that stopped listing its values, as Apicurio's `ArtifactType` did, declared once at the schema. A field whose values moved between being listed in place and being a named schema's is compared by the values it holds, so Okta's custom role type, which went from `CUSTOM` alone to every role type there is, is asked about as a fold; one that stopped referring to a vocabulary that itself changed is left to that vocabulary's own Change, which already runs there. An `enumMap` reads `const: x` as the one value it lists.
- 407f319: A new op, `status {endpoint, from, to}`, for an operation that answers with another success status: Gitea 1.25 answers the creation of an Actions variable `201` where 1.24 answered `204`, and Immich 1.138 answers `204` where 1.137 answered `200` with nothing. An old caller is answered `from` wherever the operation now answers `to`, and what happens to the body is read from the two contracts: none where the old contract promised none, the body served as any body is where both carry one, and the Change refused where the old status promised a body the new one does not carry. It is exact. A success status removed is now adaptable, and the proposer drafts the op where the documents settle which status replaced which. Programs carry it as a site's `status` rules, which the TypeScript runtime, the Node binding and the Go engine's net/http middleware apply in turn to the provider's status, and which compose across a chain of releases; the response work of a release is filed under the status the provider answers with. A chain now finds each release's response work for a status as the runtime does, by the exact status, then its class, then `default`. A `move` may place a value beneath its own place, as Meilisearch's list of a rule's actions became the `pin` list of an object there, and a field of an object that declares no properties may be moved out of it. The TypeScript runtime now writes a copy of an object a `set` writes, as the Go engine always has, so a later write into one place no longer reaches every place it was written and the program itself. The proxy passes on an empty Host, HTTP/1.1's way of naming no host, where it refused it: Immich's suite sends one to see its share pages fall back to their public address. And a GET that came with a body is sent on without the length of the body it is not sent, where the provider waited for bytes that never came.
- Updated dependencies [6edee60]
- Updated dependencies [cba62b1]
- Updated dependencies [d9ab966]
- Updated dependencies [407f319]
- Updated dependencies [f2f666a]
- Updated dependencies [ca7c00e]
  - @invariant-app/ir@0.4.0

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
