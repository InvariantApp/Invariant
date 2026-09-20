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

The release gate is wired up as `invariant check`, and it runs every
verification layer the design calls for short of the signed bundle. Still to
come: signed evolution bundles and the registry, and the GitHub App that
delivers migrations as pull requests.

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
packages/proposer     drafts candidate Changes; proposals only, never decisions
packages/eval         measures each judge against a labelled corpus
packages/verifier     lens laws, chain equivalence, differential, conformance
packages/cli          the invariant command, run in the provider's own CI
eval/                 the corpus, recorded answers, and the ownership verdict
```

## The release gate

A provider runs this on every pull request that touches the API:

```sh
invariant check
```

It answers one question: do the Changes in this pull request completely explain
what the API actually did? Anything left over is a change nobody wrote down, and
the release does not pass with one outstanding.

```
API release check - acme-payments

Contract 2026-03-01 -> 2026-09-20
  3 declared changes
  0 additive or otherwise compatible deltas

Historical contracts still served: 2026-01-15, 2026-03-01

What was checked:
  + the Changes explain the whole breaking diff
  + each schema's Changes round trip on generated values
  + one pass equals applying each step in turn

Release status: PASS
```

Every layer says what it actually proved, because a verdict on its own hides
the thing that matters: which layers ran. "The model was confident" is not one
of the kinds a record can have.

`invariant check --full` adds the two layers that need the provider's code
running. It starts the old build and the new one from the `build:` section of
`invariant.yaml`, on ephemeral ports with fresh state, and asks both the
scenarios in `invariant/scenarios`. Production traffic is never replayed.

Equivalence is measured, not configured. The old build is run twice first, with
a clock tick between the runs, and any path that fails to reproduce itself is
compared by shape rather than by value from then on. Identifiers and timestamps
fall out of that automatically, with no list of fields to ignore and no list to
go stale.

```
  + the old build and the new build plus adapter agree
      2026-01-15: create, retrieve and list a charge: 3 requests answered the same
      by both builds, ignoring 6 generated values the old build did not keep stable
  + the running code matches its own specification
      2026-09-20: 4 responses match what contract 2026-09-20 describes
```

The layers catch different things, and the tests say which is which rather than
implying each covers the others:

| Fault | Caught by | Why not the others |
|---|---|---|
| A breaking delta nobody declared | closure | - |
| A wrong scale exponent | closure, via `multipleOf` | Scaling up and back down is the identity, so the laws see nothing, and an old caller sends 49.99 and reads 49.99 back, so the differential sees nothing either. What is wrong is the amount stored. |
| A restore or default value outside its contract | the lens laws | The constant lives in the Change, not in either specification, so no comparison of the two can reach it. |
| A conversion that refuses a legal value | the lens laws | A schema comparison never runs a value. |
| A value map whose pairs are swapped | the differential | A swapped bijection round trips perfectly and preserves the set of allowed values. |
| A handler that changed behaviour | the differential | Nothing in either specification moved. |
| A specification that has drifted from the code | conformance | Every other layer is reasoning about that document. |

### In a provider's CI

```yaml
- uses: InvariantApp/Invariant@v0
  with:
    full: "true"
```

The action posts the report on the pull request, editing the same comment on
every push rather than adding another, and fails the check when the release is
blocked. `invariant check --format markdown` is the same report if you would
rather wire it up yourself.

`invariant compile` then writes the program into the build, where it ships with
the code it belongs to. A blocked release compiles nothing, because an adapter
built from Changes that do not explain the release would serve the old contract
incorrectly.

## Drafting the Changes

`invariant propose` reads the structural diff and drafts what it can:

```
4 draft changes:
  chg_payment_amount
    `amount` became `amount_cents` on Payment.
    drafted by rules, 100% confident
  ...

3 changes it would not draft, which you will have to write yourself:
  Payment.status
    the allowed values changed (succeeded, pending went, paid, processing
    arrived). Pair them up by hand: which old value maps to which new one is
    not derivable from the shapes.
  Payment.capture_method
    newly required, and the value a caller who predates it should get is not
    in the specification
```

Deterministic rules go first, so a model is only asked what spelling cannot
settle. The ops are always derived from the declared shapes: a judge says which
field replaced which, never what the scale factor is.

Which judge is allowed to draft at all is decided by measurement, in
[`eval/ownership.yaml`](eval/ownership.yaml), against a labelled corpus that
includes instructions smuggled into pull request notes. Answers are recorded, so
the evaluation runs in CI offline and for nothing.

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
