# @invariant-app/cli

## 0.5.0

### Minor Changes

- d9cad85: A consumer can migrate from a provider's published release with no account and no key, and a monorepo is migrated package by package into one result.
  
  `/.well-known/invariant.json` is new: a small, versioned document a provider serves from its own domain, listing the APIs it publishes and the Ed25519 keys it signs their releases with, each with `added_at` and optionally `not_after`, `revoked`, `revoked_reason` and the APIs it signs for, and optionally where its bundles are published. `@invariant-app/bundle` exports its schema as `@invariant-app/bundle/well-known.schema.json`, and `parseWellKnown`, `buildWellKnown`, `keyRefusal` and `openWithWellKnown`, which opens a bundle only if a key the document lists for that API, added before the bundle was published, not past its `not_after` and never revoked, signed it; anything else is an `UntrustedBundleError` that says which rule failed.
  
  `invariant well-known` prints the document from `invariant.yaml` and the keys given with `--key` (and the public half of `INVARIANT_SIGNING_KEY`), keeps every key of the document given with `--from`, and retires (`--retire`) or revokes (`--revoke`) a key by its id.
  
  A migration job can name `release: { provider, api, to?, since?, service? }` instead of a bundle: the Changes are read from the service's public bundle endpoint, every step from `since` to `to`, and trusted only if the provider's own document, read from `https://<provider>/.well-known/invariant.json`, vouches for the key that signed each one, whatever the service says. Every request is HTTPS (plain HTTP only to a service on this machine), follows redirects only on the same host, and is held to a size and a time limit; what is read is cached briefly in the user's cache directory and checked again when read back. `--service` overrides where bundles are read from.
  
  `invariant migrate` now detects workspaces: npm, pnpm and yarn workspaces, several `pyproject.toml` files, and Go modules under a `go.work` or side by side. Each package is migrated from the release of the SDK its own manifest and lockfile say it uses (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` or what is installed; a pin, `uv.lock`, `poetry.lock` or `pdm.lock`; its `go.mod`), so a job's `from` is now optional, and a job can name one `package`. The result is one set of edits for the repository, with a `packages` report saying what happened to each package and why any was skipped; a file two packages would edit differently is left alone with a note, and a package that fails does not stop the others but fails the command.
- 8f3e365: A migration can now run in a sandbox, in two phases.
  
  `@invariant-app/sandbox` is new. Its `Sandbox` interface runs a fetch phase, which downloads the SDK releases a migration reads with install scripts off and can reach only the package registries (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `proxy.golang.org`, `sum.golang.org`, and any host a caller adds) through an egress proxy, and an analyse phase, which reads the repository with no network at all, read-only inputs and one writable output directory. Each phase runs under limits on memory, CPUs, CPU time and the wall clock, and a failure says which: `timeout`, `memory`, `cpu`, `exit`, `driver` or `unavailable`. The egress proxy is an HTTP CONNECT proxy that opens tunnels only to allowlisted host names, on 443 by default, never to a name that resolves to a private, loopback or link-local address, and never for plain HTTP; it also runs on its own as `invariant-egress-proxy`. Three drivers: `oci-rootless` runs each phase in a docker or podman container as a non-root user with a read-only root filesystem, no capabilities and `--network=none` for the analysis, and the fetch on an internal network whose only way out is the proxy; `k8s-job` runs each phase as a Job under a gVisor or Kata RuntimeClass with a NetworkPolicy that denies an analysis all traffic and a fetch everything but the proxy; `fly-machine` runs each phase in a one-shot Fly Machine that is destroyed when it exits and never restarted.
  
  `invariant migrate <job.json>` is new: it moves one consumer repository to a release with the same engine the hosted service runs, for TypeScript, Python and Go. By default it runs in this process; `--sandbox oci-rootless` runs each phase in a container, with this same installation of the CLI mounted read-only. The language packs are optional peer dependencies of the CLI, loaded only when a job needs one.
  
  The go command the Go pack runs now keeps `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` from the environment, so it reaches the module proxy from behind a proxy, as a sandboxed fetch does; nothing else of the caller's environment is kept.
  
  A TypeScript consumer migrated through its tsconfig now gets edits when its SDK is installed the usual way, as declarations under node_modules: the engine now reads the SDK's declarations it is given even where the project resolves them without listing them.
- eeeb512: `invariant compile` writes `invariant.lock` beside the program, naming it by the digest the evolution bundle records. Given that digest as `programDigest`, `createRuntime` refuses at load any other program, so one changed between the build and the server is never served; `programDigest` is exported for checking a program by hand.
  
  `invariant check` refuses a release whose behavior flag is used in authentication or authorization code, found by the file's path or the words around the flag. A caller chooses its own contract, so a branch on it there would let a caller choose its own permissions.
  
  `migrate` takes an optional `repair`, a model asked for each function a site was left to a person in. It is sent the Change, why the site was left, and that function only; what it returns is kept only as that one function, type-checking as well as before, and is reported in `repairs` as the model's. Without `repair` no model is asked.
  
  The oasdiff platform packages carry a CycloneDX bill of materials naming the upstream binary by version, source and hash, as every other package already does.

### Patch Changes

- 353f443: `invariant check` fits in memory on Stripe-sized specifications. The lens laws built the generator for a schema in full before drawing a value, one generator for every path through the schemas it reaches, and where nearly every object reaches nearly every other, as Stripe's do through expandable fields, that ran out of a 12 GB heap. A schema's generator is now built the first time a value is drawn from it, and one schema reached along many paths shares one generator per depth. The values drawn, and their shrinks, are the same as before.
  
  The lens laws also finish in reasonable time there. Declared losses are parsed once per schema and removed in one walk, the release's shared blocks are compiled once rather than for every schema, and a law that fails tries at most a thousand smaller values before reporting the smallest it found, saying so when a smaller one may exist. A law on one Stripe object had been shrinking a 1.6 MB value for an hour and a half.
  
  `schemaLenses` returns the lens of any schema of one release, compiling the release's shared blocks once; `schemaLens` is the same for one schema.
- Updated dependencies [d9cad85]
- Updated dependencies [0672745]
- Updated dependencies [96ba46a]
- Updated dependencies [353f443]
- Updated dependencies [19b8562]
- Updated dependencies [c1f600c]
- Updated dependencies [2308653]
- Updated dependencies [8f3e365]
- Updated dependencies [2ab33a0]
- Updated dependencies [82928ae]
- Updated dependencies [eeeb512]
- Updated dependencies [44e1f3b]
- Updated dependencies [af96b68]
- Updated dependencies [2ab33a0]
- Updated dependencies [415673a]
- Updated dependencies [5fed925]
- Updated dependencies [268385d]
  - @invariant-app/bundle@0.5.0
  - @invariant-app/diff@0.5.0
  - @invariant-app/migrate-py@0.5.0
  - @invariant-app/verifier@0.5.0
  - @invariant-app/compiler@0.5.0
  - @invariant-app/migrate-go@0.5.0
  - @invariant-app/migrate-ts@0.5.0
  - @invariant-app/sandbox@0.5.0
  - @invariant-app/proposer@0.5.0
  - @invariant-app/migrate-core@0.5.0
  - @invariant-app/contract@0.5.0
  - @invariant-app/client@0.5.0
  - @invariant-app/ir@0.5.0

## 0.4.0

### Patch Changes

- ca7c00e: XML bodies are served. Amazon's CloudFront and CloudSearch declare every body as `text/xml`, and every Change to them was left unexplained because nothing read XML. The contract now reads an operation's XML body where it has no JSON one, so the proposer drafts for it and the prediction checks it as it does JSON; the compiler describes each XML body a site has work for, from the schema's OpenAPI `xml` object (element or attribute, wrapped or not, names, namespaces and what each place holds), as a site's `xml` program, a new program feature that asks for the next runtime; and the TypeScript runtime, the Node binding and the Go engine with its net/http middleware decode such a body into a tree, run the same instructions and write it back. Only the places the program names are decoded: every other element, and everything between elements, is written back exactly as it came, so a document nothing changed comes out byte for byte. The parser is written for hostile input: a document type declaration is refused, so no entity is expanded and nothing external is read, and nesting and namespace declarations are capped. What cannot be written back exactly is refused rather than guessed at: text among an object's elements, attributes on a value, an encoding other than UTF-8, and, at compile time, a map, a schema that contains itself, or a value read whose schema says nothing of it, which the release gate blocks. A program that reaches a parameter and an XML body at once is served too, as one with a form body is. A restatement of a whole body is no longer refused as a value with nowhere to be written back, since it writes nothing: CloudSearch restates each request body whole. The proposer also no longer asks a vocabulary decision where a case codec already serves the field, as Adyen's `Active` becoming `active`.
- Updated dependencies [6edee60]
- Updated dependencies [5da65b3]
- Updated dependencies [9458d83]
- Updated dependencies [cba62b1]
- Updated dependencies [d9ab966]
- Updated dependencies [407f319]
- Updated dependencies [f2f666a]
- Updated dependencies [ca7c00e]
  - @invariant-app/ir@0.4.0
  - @invariant-app/compiler@0.4.0
  - @invariant-app/proposer@0.4.0
  - @invariant-app/contract@0.4.0
  - @invariant-app/diff@0.4.0
  - @invariant-app/verifier@0.4.0
  - @invariant-app/bundle@0.4.0
  - @invariant-app/client@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [e94a03b]
- Updated dependencies [782ec22]
- Updated dependencies [0036e1f]
- Updated dependencies [f6c24ad]
- Updated dependencies [ac59d08]
- Updated dependencies [0036e1f]
- Updated dependencies [746be4e]
- Updated dependencies [e2168b7]
- Updated dependencies [d781b98]
- Updated dependencies [4d37d14]
- Updated dependencies [0036e1f]
- Updated dependencies [ac59d08]
  - @invariant-app/contract@0.3.0
  - @invariant-app/verifier@0.3.0
  - @invariant-app/proposer@0.3.0
  - @invariant-app/compiler@0.3.0
  - @invariant-app/diff@0.3.0
  - @invariant-app/bundle@0.3.0
  - @invariant-app/client@0.3.0
  - @invariant-app/ir@0.3.0

## 0.2.0

### Minor Changes

- 1caa64c: The release report says what callers on the old contract will notice: how many changes they will not notice, how many they carry on through with something declared lost, and how many nothing can serve, each of the last two named. With `--impact` it also says how many callers are still on each old contract, from the service's own counters.
- ea463aa: `invariant observe` stands in front of an API, adapts nothing, and reports where its answers do not match its own specification, with no value from any response in the report. A contract can be given a deprecation and a sunset date in `invariant.yaml`, which the runtime tells that contract's callers on every answer. A JSON body is read whatever the provider called its media type, which the runtime already did.
- 60a6ebf: SDK maps: `invariant publish` now sends each map in `invariant/sdks/` before the signed releases, and the client has `putSdk` and `listSdks`. A map says how an SDK names what the contract describes, which is what the migration service needs to open a pull request in a consumer's repository.

### Patch Changes

- 80b2b43: `invariant verify --rebuild` refuses a bundle whose source commit is not a commit id before handing it to git, where a signed `--orphan=x` would have been read as an option.
- Updated dependencies [34628d6]
- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [7c44320]
- Updated dependencies [2ceed93]
- Updated dependencies [80b2b43]
- Updated dependencies [fad78f7]
- Updated dependencies [fad78f7]
- Updated dependencies [7c44320]
- Updated dependencies [e4f8878]
- Updated dependencies [2e2c416]
- Updated dependencies [ea463aa]
- Updated dependencies [1e2171a]
- Updated dependencies [7c44320]
- Updated dependencies [80b2b43]
- Updated dependencies [42dacb5]
- Updated dependencies [5ed3fbf]
- Updated dependencies [7b002b6]
- Updated dependencies [a136b88]
- Updated dependencies [48948ea]
- Updated dependencies [60a6ebf]
- Updated dependencies [e5723a1]
- Updated dependencies [9ee5787]
- Updated dependencies [51ab64d]
- Updated dependencies [73d1913]
- Updated dependencies [80b2b43]
- Updated dependencies [e5723a1]
- Updated dependencies [d712bcf]
- Updated dependencies [fad78f7]
  - @invariant-app/proposer@0.2.0
  - @invariant-app/diff@0.2.0
  - @invariant-app/compiler@0.2.0
  - @invariant-app/ir@0.2.0
  - @invariant-app/contract@0.2.0
  - @invariant-app/verifier@0.2.0
  - @invariant-app/client@0.2.0
  - @invariant-app/bundle@0.2.0
