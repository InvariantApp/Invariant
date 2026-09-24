# @invariant-app/migrate-go

## 0.4.0

### Minor Changes

- af64a34: A value the consumer writes to a field the upgraded SDK no longer has is followed to where it is made, as a rejected argument already was. slack-go's reactions listing moved from pages to cursors, and `Page: page` in a helper's options no longer compiled; the helper's `page` parameter and every call that passes one in are now shown with it, since each has to change with the field.
- c6d1cac: A fixture nothing types is read as the schema it says it is. Stripe tags every object it sends with its type, `"object": "invoice"`, and a recorded webhook or a test's stand-in copies the tag with everything else; given `tags` in the symbol map, every pack now shows a person each entry of such a literal that a Change removed or moved from its schema, and each event recorded at the API version the consumer's SDK spoke before the upgrade (its `api_version`), which the upgrade moves; one recorded long before was left behind already, and is not shown. The literal is read the same way in every language, as JSON in a Go raw string, a Python dictionary or a TypeScript object, and is never rewritten: what a fixture should hold instead is the API's answer, not an edit of the old one. `taggedObjectSites` and `goneFields` are exported from `@invariant-app/migrate-core` for a pack of its own.

### Patch Changes

- 4c240f2: The check against the new release lets the go command update its copy of go.mod as it needs to. foks-proj/go-foks moved stripe-go from 81 to 82, and after `go get` the copy still wanted updates that `-mod=readonly` refused; reading export data, the loader took the failed build for one that listed no packages, and the check read no file and reported nothing, though `Invoice.Charge` was gone. A load that lists nothing now fails with what the go command said, so the result is marked `unverified` rather than clean, and `filesChecked` says how many files each pass read.
- 407f319: A new op, `status {endpoint, from, to}`, for an operation that answers with another success status: Gitea 1.25 answers the creation of an Actions variable `201` where 1.24 answered `204`, and Immich 1.138 answers `204` where 1.137 answered `200` with nothing. An old caller is answered `from` wherever the operation now answers `to`, and what happens to the body is read from the two contracts: none where the old contract promised none, the body served as any body is where both carry one, and the Change refused where the old status promised a body the new one does not carry. It is exact. A success status removed is now adaptable, and the proposer drafts the op where the documents settle which status replaced which. Programs carry it as a site's `status` rules, which the TypeScript runtime, the Node binding and the Go engine's net/http middleware apply in turn to the provider's status, and which compose across a chain of releases; the response work of a release is filed under the status the provider answers with. A chain now finds each release's response work for a status as the runtime does, by the exact status, then its class, then `default`. A `move` may place a value beneath its own place, as Meilisearch's list of a rule's actions became the `pin` list of an object there, and a field of an object that declares no properties may be moved out of it. The TypeScript runtime now writes a copy of an object a `set` writes, as the Go engine always has, so a later write into one place no longer reaches every place it was written and the program itself. The proxy passes on an empty Host, HTTP/1.1's way of naming no host, where it refused it: Immich's suite sends one to see its share pages fall back to their public address. And a GET that came with a body is sent on without the length of the body it is not sent, where the provider waited for bytes that never came.
- Updated dependencies [6edee60]
- Updated dependencies [cba62b1]
- Updated dependencies [d9ab966]
- Updated dependencies [407f319]
- Updated dependencies [c6d1cac]
- Updated dependencies [1ba578b]
- Updated dependencies [f2f666a]
- Updated dependencies [ca7c00e]
  - @invariant-app/ir@0.4.0
  - @invariant-app/migrate-core@0.4.0

## 0.3.0

### Patch Changes

- @invariant-app/ir@0.3.0
  - @invariant-app/migrate-core@0.3.0

## 0.2.0

### Minor Changes

- 9302f20: A migration language pack for Go. A small helper built on `go/packages` and `go/types` finds every reference to an SDK by the object it resolves to, reads fields by the wire name their `json` tag gives them, and reads the API operations go-github's methods say they call. The pack moves imports to the SDK's new major version, rewrites what a Change or the SDK itself renamed exactly, rewrites calls to what the new release marks `//go:fix inline` into what they do (go-github's `String(v)` into `Ptr(v)`, with the type argument spelled out where an untyped constant needs it), and type-checks the result against the new release with go.mod moved in a copy. Whatever still does not compile is shown to a person together with everything it reaches: where a value a call no longer takes was made, and the consumer's own wrappers, interfaces, other implementations and callers that pass it on, including through a method the SDK replaced with one that calls the same operation. The go toolchain runs with `GOTOOLCHAIN=local`, `-mod=readonly`, no cgo and modules only through the proxy, and the consumer's code, tests and generators are never run.
  
  `@invariant-app/migrate-core` gains `Offsets`, which converts between the UTF-8 byte offsets a compiler reports and the string offsets an edit applies at.

### Patch Changes

- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [9302f20]
- Updated dependencies [ea463aa]
- Updated dependencies [1e2171a]
- Updated dependencies [7aa6dbe]
- Updated dependencies [48948ea]
- Updated dependencies [d712bcf]
  - @invariant-app/ir@0.2.0
  - @invariant-app/migrate-core@0.2.0
