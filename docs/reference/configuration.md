# `invariant.yaml`

The configuration lives in the API's own repository, beside its code, so a
check reads nothing but the repository. Its schema is
[`packages/cli/invariant.schema.json`](../../packages/cli/invariant.schema.json);
editors that understand JSON Schema complete and check it if the file starts
with:

```yaml
# yaml-language-server: $schema=https://github.com/InvariantApp/Invariant/raw/main/packages/cli/invariant.schema.json
```

A setting the schema does not know is refused, never ignored.

## `api`

The API's name: what its runtimes, signed releases and the hosted service call
it. Lowercase letters, digits and dashes.

## `spec`

Where each contract's OpenAPI document comes from.

### `spec.current`

The contract being built. Either a path to a committed document:

```yaml
spec:
  current: openapi/openapi.json
```

or, for a document generated from code, the command that writes it and where:

```yaml
spec:
  current:
    command: npm run --silent openapi > build/openapi.json
    out: build/openapi.json
```

The command runs through the shell in the repository's root before every
check, so the gate always reads what the code says now.

### `spec.current.command`

The command that writes the document.

### `spec.current.out`

The file the command writes.

### `spec.currentLabel`

What the contract being built is called before it is released. Set it: without
it the compiled program is named after the day it was built, and the same
commit produces a different artifact tomorrow.

### `spec.released`

Every contract still served, by label, to its committed document:

```yaml
spec:
  released:
    "2026-03-01": invariant/contracts/2026-03-01.openapi.json
```

### `spec.released.<label>`

One released contract's document. `invariant release` adds these;
`invariant retire --write` removes them.

## `identity`

How a request names the contract it expects. The first strategy that matches
decides; the list is compiled into the program, so every runtime and the proxy
read this one declaration.

```yaml
identity:
  - kind: header
    name: acme-version
  - kind: principal
  - kind: default
    label: "2026-03-01"
```

### `identity[].kind`

`header`, `urlPrefix`, `principal` or `default`.

### `identity[].name`

For `header`: the request header that carries the label.

### `identity[].map`

For `urlPrefix`: path prefixes to the contract each one means, as
`{ "/v1": "2026-03-01", "/v2": "2026-09-20" }`.

### `identity[].map.<label>`

One prefix's contract.

### `identity[].label`

For `default`: the contract a request that names none is on.

### `identity[].description`

For whoever reads the file. Not compiled.

## `scenarios`

Requests `invariant check --full` sends every build, made from each released
contract's own document.

### `scenarios.generate`

`missing` (the default): for a contract with no scenarios written by hand.
`always`: beside the ones written by hand. `never`: not at all.

### `scenarios.headers`

Headers every generated request carries, such as a test credential.

### `scenarios.headers.<label>`

One header's value.

## `build`

How to stand up builds, so `check --full` can compare what the old and new
builds do. Without it the release is still checked against the
specifications, and the report says that is all it proved.

### `build.head`

The current build: exactly one of `command`, `image`, `compose` or `url`.
A command is run in this repository; the others are for a service that is
not started from here, such as one CI has just built into an image.

```yaml
build:
  head:
    image: acme/api:candidate   # tagged by the CI step that built it
    port: 8080
    proxy: true
```

### `build.head.command`

Starts the server. `PORT` is set to the port it must listen on.

### `build.head.image`

The current build's image, run with Docker.

### `build.head.port`

The port the image listens on. Default 8080.

### `build.head.compose`

A Compose file that starts the current build and what it needs, publishing
the API on `${PORT}`. See `build.contracts.<label>.compose`.

### `build.head.url`

An environment already running the current build.

### `build.head.proxy`

Stand Invariant's proxy in front of the current build, running the program
this check compiled. Set it when production runs the proxy (`invariant-sidecar`)
rather than an in-process binding, which is the case for every API not written
in Node: without it the current build alone never serves an old contract, and
the comparison would be of the wrong thing. Default `false`.

### `build.head.env`

Environment for the current build.

### `build.head.env.<label>`

One variable.

### `build.base`

A released contract's build, when it is the current code started differently.

### `build.base.command`

Starts a released contract's build, when not the way the current build is
started.

### `build.base.env`

Environment for a released contract's build. `${contract}` is replaced with
the label being built.

### `build.base.env.<label>`

One variable.

### `build.healthPath`

Answers 200 once the server is ready. Default `/__health`.

### `build.readyTimeout`

Seconds a build has to answer on `healthPath`. Default 30; a service that
migrates a database as it starts needs a few minutes.

### `build.startPer`

`scenario` (the default) starts fresh builds for every scenario. `contract`
starts each build once per run and asks it every scenario of a contract in
turn, which is what a build that takes a minute to start needs. Each of the
three runs (the old build twice, then the current one) still begins from
fresh state and asks the same things in the same order, so the calibration
still finds exactly what the old build does not keep stable.

### `build.contracts`

A released contract's own build, by label, when it is not the current code:
an environment already running, the image that was released, a Compose file
that starts it with its database, or the commit it came from. Which one was
used is recorded in the differential evidence.

```yaml
build:
  contracts:
    "2026-01-15": { url: https://staging-2026-01.acme.test }
    "2026-03-01": { image: ghcr.io/acme/api:2026-03-01, port: 8080 }
    "2026-04-01": { compose: deploy/compose.yaml, env: { TAG: "${contract}" } }
    "2026-06-01": { worktree: v2026-06-01, install: npm ci, command: npm start }
```

A `url` source is an environment someone else keeps running, so its state is
shared by every run: the calibration can still tell what varies between two
answers, but not what a fresh start would have said. It is what retroactive
onboarding points at: the old version, still deployed, as the oracle for the
Changes that let its handlers be deleted.

### `build.contracts.<label>`

One released contract's build: exactly one of `url`, `image`, `compose` or
`worktree`.

### `build.contracts.<label>.url`

An environment already running that contract.

### `build.contracts.<label>.image`

The image that was released, run with Docker.

### `build.contracts.<label>.port`

The port the image listens on. Default 8080.

### `build.contracts.<label>.compose`

A Compose file, relative to `invariant.yaml`, that starts the build and
everything it needs. It publishes the API on `${PORT}` (set for it), and reads
`env` (with `${contract}` filled in) for anything else, such as which image
tag to run. Every start is its own Compose project, taken down with its
volumes afterwards, so no run sees another's data.

```yaml
services:
  api:
    image: ghcr.io/acme/api:${TAG}
    ports: ["127.0.0.1:${PORT}:8080"]
    depends_on: [db]
  db:
    image: postgres:17
```

### `build.contracts.<label>.worktree`

The tag or commit the contract was released from, checked out beside the
repository.

### `build.contracts.<label>.install`

Run in the checkout before it starts, such as `npm ci`.

### `build.contracts.<label>.command`

Starts the checked-out build.

### `build.contracts.<label>.env`

Environment for this build.

### `build.contracts.<label>.env.<label>`

One variable.

## `gate`

What the release gate does about the things a provider may decide on:
`block`, `warn` (the default) or `allow`. Unexplained breaking changes and
failed verification always block.

### `gate.declaredLossy`

A Change that serves old callers with something lost, and says so.

### `gate.unmigratableWithActiveConsumers`

A Change no codemod can apply, while consumers still use what it changes.

## `retirement`

When each released contract is deprecated and when it stops being served, by
label. What a provider decides here is told to that contract's callers on every
answer, as `Deprecation` (RFC 9745) and `Sunset` (RFC 8594), so a caller learns
it from the API rather than from a changelog it may never read. A header the
provider's own code already set is left as it is.

```yaml
retirement:
  "2026-01-15":
    deprecated: 2026-06-01
    sunset: 2026-12-31
```

Only a contract listed in `spec.released` can be given an end, and both dates
are optional: a contract may be deprecated long before a date is set for its
end. Neither date changes what the runtime serves; `invariant retire` is what
stops serving a contract, and it goes by what callers actually still use.

### `retirement.<label>`

One released contract's end.

### `retirement.<label>.deprecated`

The day this contract was deprecated. A date, or a date and time.

### `retirement.<label>.sunset`

The day this contract stops being served.
