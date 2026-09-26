# @invariant-app/bundle

## 0.5.0

### Minor Changes

- d9cad85: A consumer can migrate from a provider's published release with no account and no key, and a monorepo is migrated package by package into one result.
  
  `/.well-known/invariant.json` is new: a small, versioned document a provider serves from its own domain, listing the APIs it publishes and the Ed25519 keys it signs their releases with, each with `added_at` and optionally `not_after`, `revoked`, `revoked_reason` and the APIs it signs for, and optionally where its bundles are published. `@invariant-app/bundle` exports its schema as `@invariant-app/bundle/well-known.schema.json`, and `parseWellKnown`, `buildWellKnown`, `keyRefusal` and `openWithWellKnown`, which opens a bundle only if a key the document lists for that API, added before the bundle was published, not past its `not_after` and never revoked, signed it; anything else is an `UntrustedBundleError` that says which rule failed.
  
  `invariant well-known` prints the document from `invariant.yaml` and the keys given with `--key` (and the public half of `INVARIANT_SIGNING_KEY`), keeps every key of the document given with `--from`, and retires (`--retire`) or revokes (`--revoke`) a key by its id.
  
  A migration job can name `release: { provider, api, to?, since?, service? }` instead of a bundle: the Changes are read from the service's public bundle endpoint, every step from `since` to `to`, and trusted only if the provider's own document, read from `https://<provider>/.well-known/invariant.json`, vouches for the key that signed each one, whatever the service says. Every request is HTTPS (plain HTTP only to a service on this machine), follows redirects only on the same host, and is held to a size and a time limit; what is read is cached briefly in the user's cache directory and checked again when read back. `--service` overrides where bundles are read from.
  
  `invariant migrate` now detects workspaces: npm, pnpm and yarn workspaces, several `pyproject.toml` files, and Go modules under a `go.work` or side by side. Each package is migrated from the release of the SDK its own manifest and lockfile say it uses (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` or what is installed; a pin, `uv.lock`, `poetry.lock` or `pdm.lock`; its `go.mod`), so a job's `from` is now optional, and a job can name one `package`. The result is one set of edits for the repository, with a `packages` report saying what happened to each package and why any was skipped; a file two packages would edit differently is left alone with a note, and a package that fails does not stop the others but fails the command.

### Patch Changes

- Updated dependencies [353f443]
- Updated dependencies [268385d]
  - @invariant-app/verifier@0.5.0
  - @invariant-app/contract@0.5.0
  - @invariant-app/ir@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [6edee60]
- Updated dependencies [9458d83]
- Updated dependencies [cba62b1]
- Updated dependencies [d9ab966]
- Updated dependencies [407f319]
- Updated dependencies [f2f666a]
- Updated dependencies [ca7c00e]
  - @invariant-app/ir@0.4.0
  - @invariant-app/contract@0.4.0
  - @invariant-app/verifier@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [e94a03b]
- Updated dependencies [782ec22]
- Updated dependencies [0036e1f]
- Updated dependencies [0036e1f]
- Updated dependencies [e2168b7]
- Updated dependencies [4d37d14]
- Updated dependencies [0036e1f]
- Updated dependencies [ac59d08]
  - @invariant-app/contract@0.3.0
  - @invariant-app/verifier@0.3.0
  - @invariant-app/ir@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [7c44320]
- Updated dependencies [2e2c416]
- Updated dependencies [ea463aa]
- Updated dependencies [1e2171a]
- Updated dependencies [80b2b43]
- Updated dependencies [a136b88]
- Updated dependencies [48948ea]
- Updated dependencies [d712bcf]
  - @invariant-app/ir@0.2.0
  - @invariant-app/contract@0.2.0
  - @invariant-app/verifier@0.2.0
