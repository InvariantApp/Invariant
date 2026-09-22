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

The current build.

### `build.head.command`

Starts the server. `PORT` is set to the port it must listen on.

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

### `build.contracts`

A released contract's own build, by label, when it is not the current code:
an environment already running, the image that was released, or the commit it
came from.

```yaml
build:
  contracts:
    "2026-01-15": { url: https://staging-2026-01.acme.test }
    "2026-03-01": { image: ghcr.io/acme/api:2026-03-01, port: 8080 }
    "2026-06-01": { worktree: v2026-06-01, install: npm ci, command: npm start }
```

### `build.contracts.<label>`

One released contract's build: exactly one of `url`, `image` or `worktree`.

### `build.contracts.<label>.url`

An environment already running that contract.

### `build.contracts.<label>.image`

The image that was released, run with Docker.

### `build.contracts.<label>.port`

The port the image listens on. Default 8080.

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
