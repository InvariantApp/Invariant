# @invariant-app/migrate-go

## 0.5.0

### Minor Changes

- 19b8562: A Go migration now rewrites more of what the Changes determine, where it used to show every reference to the field:
  
  - A value the contract renamed is rewritten where it is one of the SDK's named string type's values (`CustomerStatus`) and every field it meets is one the Change covers: compared with the field, sent in a request, a case of a switch, listed in a `[]CustomerStatus`, compared with the field converted to a plain string (`string(c.Status) == "active"`), or compared inside the consumer's own helper, where every call passes it the field. An SDK that gives a response's field and a request's the same type keeps the other side's values as they are; a value that meets both, or something that cannot be followed to a field, is shown. A literal of plain `string` compared with nothing of the SDK's is left alone.
  - An amount now in minor units is converted with the SDK's exact helpers, named in the symbol map's new `helpers` and checked against both releases: `sdk.FromMinorUnits(customer.Balance)` where it is read, `sdk.ToMinorUnits(credit * 2)` where it is sent, and a literal on its digits, `Balance: 1250`. A read from a variable the function checks for nil is still shown, since what the absent case becomes is the consumer's choice.
  - A field that moved into an object of its struct is read through it (`customer.Contact.Phone`) and written into a literal of it (`Contact: &sdk.Contact{Phone: mobile}`).
  - A request field that became required, with the value it always had, is written into each literal that builds the request, and a literal standing in for a response that gained a field is shown.
  - A field an embedded struct promotes is found through the struct that embeds it, and a field named through reflection on the SDK's struct (`FieldByName("Nickname")`) is renamed.
  - A key read from untyped JSON (`map[string]any`) that names a moved, removed or re-encoded field is shown where the map provably holds the SDK's data: returned by a call into the SDK, passed to one, or decoded from bytes one returned.

### Patch Changes

- 8f3e365: A migration can now run in a sandbox, in two phases.
  
  `@invariant-app/sandbox` is new. Its `Sandbox` interface runs a fetch phase, which downloads the SDK releases a migration reads with install scripts off and can reach only the package registries (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `proxy.golang.org`, `sum.golang.org`, and any host a caller adds) through an egress proxy, and an analyse phase, which reads the repository with no network at all, read-only inputs and one writable output directory. Each phase runs under limits on memory, CPUs, CPU time and the wall clock, and a failure says which: `timeout`, `memory`, `cpu`, `exit`, `driver` or `unavailable`. The egress proxy is an HTTP CONNECT proxy that opens tunnels only to allowlisted host names, on 443 by default, never to a name that resolves to a private, loopback or link-local address, and never for plain HTTP; it also runs on its own as `invariant-egress-proxy`. Three drivers: `oci-rootless` runs each phase in a docker or podman container as a non-root user with a read-only root filesystem, no capabilities and `--network=none` for the analysis, and the fetch on an internal network whose only way out is the proxy; `k8s-job` runs each phase as a Job under a gVisor or Kata RuntimeClass with a NetworkPolicy that denies an analysis all traffic and a fetch everything but the proxy; `fly-machine` runs each phase in a one-shot Fly Machine that is destroyed when it exits and never restarted.
  
  `invariant migrate <job.json>` is new: it moves one consumer repository to a release with the same engine the hosted service runs, for TypeScript, Python and Go. By default it runs in this process; `--sandbox oci-rootless` runs each phase in a container, with this same installation of the CLI mounted read-only. The language packs are optional peer dependencies of the CLI, loaded only when a job needs one.
  
  The go command the Go pack runs now keeps `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` from the environment, so it reaches the module proxy from behind a proxy, as a sandboxed fetch does; nothing else of the caller's environment is kept.
  
  A TypeScript consumer migrated through its tsconfig now gets edits when its SDK is installed the usual way, as declarations under node_modules: the engine now reads the SDK's declarations it is given even where the project resolves them without listing them.
- 415673a: The Python pack finds values a parameter no longer takes, written as literals.
  
  An SDK declares a parameter's vocabulary, as openai-python's `model` is `Union[str, ChatModel]`, and a release that drops a value from it means the API retired that value. The checker never says so, since the parameter takes any text too. The pack now reads each parameter's vocabulary from both releases' declarations, the literal aliases it names and the literals written into its annotation, and a string literal the consumer sends as the SDK's own parameter, directly or through a name bound to it, is a site wherever the old release lists it and the new one does not: rewritten where a Change maps the value (`enumMap`), shown otherwise. A function of the consumer's that takes a parameter of the same name is left alone.
  
  `buildPlan` gathers these values from every Change into the plan's new `retiredValues`: each old value an `enumMap` renames, with what it is sent as now, and each value a `dropValues` leaves out of a list, whatever the Change is scoped to.
  
  A site shown to a person may say where the changed element itself is written, as `at`, where what it shows is wider: the read of a moved field inside the statement around it, the key a plain HTTP request sends, the name of a removed class inside the call that builds one. The Python and Go packs say so.
- Updated dependencies [44e1f3b]
- Updated dependencies [af96b68]
- Updated dependencies [415673a]
  - @invariant-app/migrate-core@0.5.0
  - @invariant-app/ir@0.5.0

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
