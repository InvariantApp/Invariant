# @invariant-app/migrate-ts

## 0.5.0

### Minor Changes

- eeeb512: `invariant compile` writes `invariant.lock` beside the program, naming it by the digest the evolution bundle records. Given that digest as `programDigest`, `createRuntime` refuses at load any other program, so one changed between the build and the server is never served; `programDigest` is exported for checking a program by hand.
  
  `invariant check` refuses a release whose behavior flag is used in authentication or authorization code, found by the file's path or the words around the flag. A caller chooses its own contract, so a branch on it there would let a caller choose its own permissions.
  
  `migrate` takes an optional `repair`, a model asked for each function a site was left to a person in. It is sent the Change, why the site was left, and that function only; what it returns is kept only as that one function, type-checking as well as before, and is reported in `repairs` as the model's. Without `repair` no model is asked.
  
  The oasdiff platform packages carry a CycloneDX bill of materials naming the upstream binary by version, source and hash, as every other package already does.
- 5fed925: A TypeScript migration now rewrites more of what the Changes determine, where it used to leave the site or only show it:
  
  - A field the response type inherits from a base interface, as `email` on a `Customer` that extends `CustomerBase`, is found and rewritten where the value is certainly the response type. A read from a value that is only the base, which other types may share, is shown.
  - A renamed enum value is rewritten as a `case` of a `switch` over the field, in a list the field is looked for in (`["active", "past_due"].includes(customer.status)`), compared with the field as text (`String(customer.status) === "active"`), and wherever it is compared with a value of the SDK's own vocabulary type (`CustomerStatus`) that comes only from the field the Change covers, as inside the consumer's own helper every call to which passes that field. An SDK that gives a response's field and a request's the same type keeps the other side's values as they are, and a value that cannot be followed to a field, or meets both, is shown.
  - A renamed field read by a string key from the SDK's object, `customer["nickname"]`, is renamed inside the string.
  - Request parameters gathered in a `const` object that is only ever passed where the SDK's request type is expected have their renamed key rewritten, and a field read from an untyped parameter every call passes the SDK's object to is rewritten. Where either is not certain, the site is still shown.
  - A tagged stand-in's entry is no longer shown once the typed rewrite has already fixed it.

### Patch Changes

- 2308653: The exact conversion helpers are imported however the consumer imports the SDK. A file that takes only the SDK's default export (`import Acme from "acme"`) gets them in braces beside it, and one that holds the SDK as a namespace, or names its types only with `import type`, gets an import of its own. Before, the first two were left calling `fromMinorUnits` with nothing imported, and the third had it added to the type-only import, where calling it does not compile.
- 8f3e365: A migration can now run in a sandbox, in two phases.
  
  `@invariant-app/sandbox` is new. Its `Sandbox` interface runs a fetch phase, which downloads the SDK releases a migration reads with install scripts off and can reach only the package registries (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `proxy.golang.org`, `sum.golang.org`, and any host a caller adds) through an egress proxy, and an analyse phase, which reads the repository with no network at all, read-only inputs and one writable output directory. Each phase runs under limits on memory, CPUs, CPU time and the wall clock, and a failure says which: `timeout`, `memory`, `cpu`, `exit`, `driver` or `unavailable`. The egress proxy is an HTTP CONNECT proxy that opens tunnels only to allowlisted host names, on 443 by default, never to a name that resolves to a private, loopback or link-local address, and never for plain HTTP; it also runs on its own as `invariant-egress-proxy`. Three drivers: `oci-rootless` runs each phase in a docker or podman container as a non-root user with a read-only root filesystem, no capabilities and `--network=none` for the analysis, and the fetch on an internal network whose only way out is the proxy; `k8s-job` runs each phase as a Job under a gVisor or Kata RuntimeClass with a NetworkPolicy that denies an analysis all traffic and a fetch everything but the proxy; `fly-machine` runs each phase in a one-shot Fly Machine that is destroyed when it exits and never restarted.
  
  `invariant migrate <job.json>` is new: it moves one consumer repository to a release with the same engine the hosted service runs, for TypeScript, Python and Go. By default it runs in this process; `--sandbox oci-rootless` runs each phase in a container, with this same installation of the CLI mounted read-only. The language packs are optional peer dependencies of the CLI, loaded only when a job needs one.
  
  The go command the Go pack runs now keeps `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` from the environment, so it reaches the module proxy from behind a proxy, as a sandboxed fetch does; nothing else of the caller's environment is kept.
  
  A TypeScript consumer migrated through its tsconfig now gets edits when its SDK is installed the usual way, as declarations under node_modules: the engine now reads the SDK's declarations it is given even where the project resolves them without listing them.
- Updated dependencies [44e1f3b]
- Updated dependencies [af96b68]
- Updated dependencies [415673a]
  - @invariant-app/migrate-core@0.5.0
  - @invariant-app/ir@0.5.0

## 0.4.0

### Minor Changes

- c6d1cac: A fixture nothing types is read as the schema it says it is. Stripe tags every object it sends with its type, `"object": "invoice"`, and a recorded webhook or a test's stand-in copies the tag with everything else; given `tags` in the symbol map, every pack now shows a person each entry of such a literal that a Change removed or moved from its schema, and each event recorded at the API version the consumer's SDK spoke before the upgrade (its `api_version`), which the upgrade moves; one recorded long before was left behind already, and is not shown. The literal is read the same way in every language, as JSON in a Go raw string, a Python dictionary or a TypeScript object, and is never rewritten: what a fixture should hold instead is the API's answer, not an edit of the old one. `taggedObjectSites` and `goneFields` are exported from `@invariant-app/migrate-core` for a pack of its own.
- c6d1cac: A stand-in for a response in a file that never imports the SDK is shown to a person where the types say it is handed to the SDK's type. hiroppy's web-app-template tests its subscription handler with `const subscription = { current_period_end: null, ... }` and `handleSubscriptionUpsert(subscription)`, whose parameter is a `Stripe.Subscription`, the mismatch silenced by `@ts-expect-error`; the field it holds is one the upgrade moved. It is never rewritten: what the test means its stand-in to hold, the types do not say.
- 1ba578b: The TypeScript pack checks the migrated consumer against the release it moves to, as the Python and Go packs do. Given `upgraded`, where the new release resolves from, it type-checks the consumer's files as they were against the release used today and as the edits left them against the new one, and shows a person each error the upgrade brought, with the checker's own words and the whole statement it is in: a field the new API version no longer sends, a parameter a method stopped taking, a fixture that no longer fits the type it claims. JavaScript is checked the same way, as `checkJs` would, and only what is new is reported. `checkFor` bounds the check in time where the type checker offers to stop, and `checker` runs each check where the caller can stop it outright, such as in a worker it ends at the deadline; a file the check did not reach is listed in the result's `unchecked` rather than holding the migration, and `trace` is told each step as it finishes. The engine itself still starts no process and no thread. `originalOffset`, which places an error in the edited text back where it was read, moves to `@invariant-app/migrate-core` for every pack, and is still exported from `@invariant-app/migrate-py`.
  
  A field a Change moved or removed is also shown where only its name says it may be the contract's: a key of an object literal nothing types, as a test's stand-in for a subscription handed to a mock, or a read or subscript of a value typed `any`, as a webhook's payload. Such a place is never rewritten, as the Python pack does with a dictionary's keys; a use typed as anything else is the checker's to decide.

### Patch Changes

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
  - @invariant-app/decimal@0.4.0

## 0.3.0

### Patch Changes

- @invariant-app/decimal@0.3.0
  - @invariant-app/ir@0.3.0
  - @invariant-app/migrate-core@0.3.0

## 0.2.0

### Patch Changes

- 80b2b43: A migration writes only inside the repository it migrates. The helpers module a symbol map asks for and the generated files a run replaces are refused before anything is read if their path is absolute or climbs out, where `../` was written wherever it pointed. Before the first file is written, every destination, `package.json` included, is checked with links followed, so a file committed as a link to another checkout is refused rather than written through, and a file is judged inside the repository by its path rather than by a prefix, so `/work/repo` no longer counts `/work/repo-other` as its own. The refusal is a `MigrationPathError`, and a refused run leaves the repository as it was.
- 7aa6dbe: Python consumers can be migrated. `@invariant-app/migrate-py` reads a Python repository against the SDK release it uses today, through pyright for what each name refers to and tree-sitter for what the code does with it, and writes the edits the Changes determine: a renamed field wherever it is read, set, passed by keyword or written as a key the type checker ties to the SDK, and a renamed value where a field is compared with it. A removed field, a subscript or `.get()` by a field's name, a read the checker cannot type, an expansion (`expand=["latest_invoice.payment_intent"]`) through a removed field and every API version pin (`stripe.api_version`, `stripe_version=`) are reported to a person, never edited. The result is then checked against the release being moved to, and every place that stops type-checking is reported with the checker's words, whether or not a Change named it, including a `match` a newly added value leaves incomplete and the consumer's own copy of values the SDK widened.
  
  The SDK and what its metadata requires are installed from wheels only, unpacked and checked against the digest the index publishes; a release with no wheel is refused rather than built. pyright is never pointed at an interpreter, so nothing of the consumer's, and no Python at all, is run.
  
  `@invariant-app/migrate-core` holds what every language pack shares: the migration plan, byte-range edits, the sites shown to a person and how a re-encoding is described. `@invariant-app/migrate-ts` re-exports them, so nothing that imports them from there changes.
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
  - @invariant-app/decimal@0.2.0
