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

Phase 0 complete: the fixture provider, its three historical contracts, three
unmodified consumer applications, and an executable demo that proves the break
is real before anything tries to fix it.

## Layout

```
docs/         design and the planning brief
fixtures/     the sample provider, its SDKs, and three consumer applications
e2e/          the demo, as an executable test
packages/     the compiler, runtime, verifier and migration engine
```

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
