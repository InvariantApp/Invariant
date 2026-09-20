# Invariant

The compilation and distribution layer for API evolution.

A provider's breaking API change is captured once, in the provider's own pull
request, as a small typed bidirectional **Change**. A deterministic compiler
proves those Changes fully explain the structural diff between the old and new
OpenAPI contracts, then derives everything downstream from the same source:
request and response adapters that keep existing integrations working, and
TypeScript codemods that move consumer code forward.

Models only ever propose a Change. A Change becomes real when it type-checks
against both contracts, passes property and differential tests, and is merged by
the provider through ordinary code review.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full system design, and
[`docs/brief`](docs/brief) for the planning brief it answers.

## Status

The demo holds end to end (`pnpm e2e`):

1. Three consumer applications pass against the contract each was written for,
   and break against the provider's new canonical API.
2. With the compiled program in the provider's build, those same three
   consumers pass against that new API **unmodified**, all three contracts
   served at once from one implementation.
3. Consumer A, two contracts behind, migrates forward: its source and its own
   tests are rewritten from the provider's confirmed Changes, with no new type
   errors, and it then passes against the new API **with no adapter at all**.
   The one site the engine would not guess at is reported with an exact
   location, and it is exactly the one test that fails until that site is dealt
   with.

Still to come: the release gate and differential verifier, signed evolution
bundles, the Jev evaluation harness, and the GitHub App that delivers
migrations as pull requests.

## Layout

```
docs/                 design and the planning brief
fixtures/             the sample provider, its SDKs, and three consumer applications
e2e/                  the demo, as an executable test
packages/ir           the Change IR and compiled program schemas
packages/decimal      exact decimal arithmetic, no dependencies
packages/contract     OpenAPI loading, digests, and schema site resolution
packages/diff         structural diff via oasdiff, and the breaking-change policy
packages/compiler     type checking, the closure check, and program projection
packages/runtime      the compatibility interpreter and provider middleware
packages/runtime-hono Hono bindings for the runtime
packages/migrate-ts   type-aware indexing and codemods for consumer repositories
```

## Requirements

Node 22.12 or newer, pnpm, and [oasdiff](https://github.com/oasdiff/oasdiff) for
the closure check:

```sh
go install github.com/oasdiff/oasdiff@latest
```

Without it the closure tests skip locally and fail on CI, because a skipped
safety check reads the same as a passing one.

## Development

Requires Node 22.12 or newer and pnpm.

```sh
pnpm install
pnpm check      # lint, typecheck, test
pnpm test       # unit and end-to-end tests
pnpm e2e        # the demo only
```

## The fixture

`fixtures/provider-acme` is a payments API with three contract-era builds that
share one store, selected with `ACME_BUILD`:

| Contract | Wire shape |
| --- | --- |
| `2026-01-15` | `POST /v1/charges`, `amount` in major units, flat `source` token |
| `2026-03-01` | `POST /v1/payments`, nested `payment_method.token` |
| `head` | `amount_cents` in minor units, new status vocabulary, required `capture_method` |

Three consumers integrate against those contracts and are never modified:

| Consumer | Contract | Client style |
| --- | --- | --- |
| `consumer-a-sdk-v1` | `2026-01-15` | nested-resource SDK |
| `consumer-b-types-v2` | `2026-03-01` | generated types with openapi-fetch |
| `consumer-c-rawfetch-v2` | `2026-03-01` | raw fetch, untyped |
