# Adding Invariant to an API

This is what a provider actually does. It assumes you have an OpenAPI document
that describes your API, and a way to start your service.

---

## 1. Describe what you serve

Create `invariant.yaml` beside your specification.

```yaml
api: acme-payments

spec:
  current: openapi/head.json
  # What the contract you are building is called, before it is released.
  # Leave this out and the compiled program is named after the day it was
  # built, so the same commit produces a different artifact tomorrow.
  currentLabel: "2026-09-20"
  released:
    "2026-01-15": openapi/2026-01-15.json
    "2026-03-01": openapi/2026-03-01.json

# How a request says which contract it expects. First match wins.
identity:
  - kind: header
    name: acme-version
  - kind: principal      # the contract pinned to the account
  - kind: default
    label: "2026-01-15"

# How to stand up a build, so the differential check has something to compare.
# `${contract}` is replaced with the contract label being built.
build:
  head:
    command: pnpm start
    env: { ACME_BUILD: head }
  base:
    command: pnpm start
    env: { ACME_BUILD: "${contract}" }
  healthPath: /__health
```

The `released` list is the set of contracts you are still willing to serve.
Removing one is how you stop.

---

## 2. Run the gate on every pull request

```yaml
- uses: InvariantApp/Invariant@v0
  with:
    full: "true"
```

It answers one question: do the Changes in this pull request completely explain
what the API actually did? Anything left over is a change nobody wrote down,
and the release does not pass with one outstanding.

With `full: true` it also starts your old build and your new one, on ephemeral
ports with fresh state, and compares what they actually do. That is the only
layer that can catch a value map whose pairs are swapped, or a handler whose
behaviour changed under an unchanged shape.

Locally, the same thing is `invariant check --full`.

---

## 3. Write the Change, or let it be drafted

When the gate blocks, it names what is unexplained. `invariant propose` drafts
what it can and says plainly what it will not:

```
4 draft changes:
  chg_payment_amount
    `amount` became `amount_cents` on Payment.
    drafted by rules, 100% confident

3 changes it would not draft, which you will have to write yourself:
  Payment.status
    the allowed values changed (succeeded, pending went, paid, processing
    arrived). Pair them up by hand: which old value maps to which new one is
    not derivable from the shapes.
```

A draft is a file you read, edit and merge. Merging it is the confirmation;
there is no separate approval step and no dashboard.

---

## 4. Put the adapter in your service

```ts
import { createRuntime } from "@invariant/runtime";
import { adapt, wrapFetch } from "@invariant/runtime-hono";
import program from "./invariant/compiled/program.json" with { type: "json" };

const inv = createRuntime({
  program,
  identity: [
    { kind: "header", name: "acme-version" },
    { kind: "principal" },
    { kind: "default", label: "2026-01-15" },
  ],
  onUsage: (event) => log.append(event),
});

app.use("/v1/*", yourAuth);        // your authentication, unchanged
app.use("/v1/*", adapt({ runtime: inv }));

// Path rewriting has to sit outside the router, so an old URL reaches the
// canonical handler at all.
export const fetch = wrapFetch((request) => app.fetch(request), { runtime: inv });
```

Your handlers are written once, against the API you have now. The compiled
program ships inside your build, so the adapter deploys and rolls back with the
code it belongs to and depends on nothing being reachable.

---

## 5. Release

```sh
INVARIANT_SIGNING_KEY="$(cat signing.key)" \
  invariant release --repo acme/payments-api --commit "$GITHUB_SHA"
```

This mints the contract label, moves the pending Changes into the released
step, and writes a signed bundle. Same inputs produce the same digest, so
anyone holding a bundle can rebuild it from your repository and compare rather
than take your word for it.

`invariant verify <bundle> --key publisher.pub` is that check.

---

## 6. When something is wrong

Two mechanisms, for two different emergencies.

**Now, without a deploy.** Write a flags file and point the runtime at it:

```json
{ "disabledChanges": ["chg_money_in_minor_units"] }
```

```ts
import { flagsFrom } from "@invariant/flags";
const flags = flagsFrom({ path: "/etc/invariant/flags.json" });
createRuntime({ program, identity, flags: flags.read });
```

Three granularities: one change, one contract, or everything. Switching a
transform off means **refusing** the affected requests, not skipping the
transform — skipping it would serve an old caller a body in the canonical
shape under field names their contract has never had, and it would look like a
success.

Callers on your current contract are never affected, because there is nothing
to switch off for them.

**Properly, with a deploy.** Revert it. The program is part of the artifact, so
there is nothing to roll back separately and nothing that can be left at a
different version than the code it belongs to.

---

## 7. Stop serving what nobody uses

The adapter counts every transform it applies, per consumer and per change. No
bodies, no field values.

```sh
invariant retire --usage invariant/usage.jsonl
```

```
  - 2026-01-15: nothing served for 90 days, against a window of 30.
  + 2026-03-01: this is the contract a caller who declares nothing is served

Safe to stop serving: 2026-01-15
```

It only ever proposes. A contract with no records at all is reported separately
from an idle one, because no telemetry is far more likely to mean the sink was
never wired up than that every consumer left.

---

## Requirements

- Node 22.12 or later.
- [`oasdiff`](https://github.com/oasdiff/oasdiff) v1.32.x on `PATH`. The gate
  will not run without it rather than checking less than it claims to.
- OpenAPI 3.x. JSON request and response bodies.
