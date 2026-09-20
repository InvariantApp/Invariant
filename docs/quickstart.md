# Adding Invariant to an API

This is what a provider actually does. Each step below is useful on its own and
none of them requires the next one, because the last thing anybody should do is
put someone else's code in their request path on a promise.

Only the first step is required to get an answer. It needs one thing: an OpenAPI
document, at two points in time.

---

## 0. Find out what you are about to break

Two specification files and five lines of configuration. No Change files, no
compiled program, nothing running in your service.

```yaml
api: acme-payments
spec:
  current: openapi/head.json
  currentLabel: "2026-09-20"
  released:
    "2026-03-01": openapi/2026-03-01.json
```

```console
$ invariant check
```

```
Release status: BLOCK

2026-03-01 -> 2026-09-20
  0 declared changes
  1 additive or otherwise compatible delta
  27 breaking deltas nothing accounts for

  - response-required-property-removed at POST /v1/payments:
      removed the required property `amount` from the response with the `201` status
  - new-required-request-property at POST /v1/payments:
      added the new required request property `capture_method`
  - response-property-enum-value-removed at GET /v1/payments:
      removed the `succeeded` enum value from the `data/items/status` response property
  ...
```

That is the whole first rung. It is an inventory of what this pull request does
to everyone already calling you, by operation and by field, and you can put it
in CI today without changing a line of your service.

Everything after this point is optional, in the order given. Stopping at any
rung leaves you with something that works.

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

If your specification is generated from your code rather than written by hand,
name the generator instead of a path and it runs at gate time:

```yaml
spec:
  current:
    command: pnpm gen:openapi
    out: openapi/head.json
```

Worth doing. Every check here reasons about the document, so a document that
has not caught up with a handler makes the gate confident about an API that
does not exist. Running the generator means it never has to catch up.

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

### When no Change could express it

Some changes are not about shape, and some are about shape in a way no op
covers: one field becoming two, a side effect moving, a union reshaped. The
catalog is small deliberately, so it has a ceiling, and you will meet it.

`invariant propose` says so by name rather than listing the fields separately:

```
1 change has no Change that could express it:

  Contact: a split
    `name` became `first_name` and `last_name`. No op takes one value apart,
    because a response has to be put back together for the old caller and
    there is no general way to rejoin what was separated.

    What you can do:
      1. Keep serving `name` as well. Deriving it alongside the new fields
         makes this release additive, and then there is nothing to explain.
      2. Declare a `behavior` Change and write the branch yourself.
      3. Stop serving the contracts that would break.
```

Option 2 is the escape hatch, and it is the same one every system that has
really solved this arrived at. `invariant check` prints the deltas ready to
paste:

```yaml
ops:
  - op: behavior
    flag: chg_contact_name_split
    covers:
      - "request-property-removed at POST /v1/contacts: removed the request property `name`"
      # ...one line per delta, exactly as the gate printed it
```

Then your own handler branches:

```ts
import { before } from "@invariant/runtime-hono";

app.post("/v1/contacts", async (c) => {
  const body = await c.req.json();
  const contact = before(inv, c, "chg_contact_name_split")
    ? splitName(body.name)
    : { first_name: body.first_name, last_name: body.last_name };
  // ...
});
```

Three things about this, which are the reasons it is not simply a way to
switch the gate off:

- **It is a list, not a wildcard.** A delta you did not name still blocks, and
  a delta you named that no longer happens also blocks. An acknowledgement
  cannot quietly start covering something you have not read.
- **The release warns; it never passes.** Nothing transforms anything here.
  Old callers get the new behaviour unless your code branches, and only your
  tests can show that it does.
- **Asking about a flag nothing declares throws.** A typo answering `false`
  would hand every old caller the new behaviour, silently and forever.

A behaviour branch is counted like any other change, so `invariant retire`
can eventually tell you the branch is dead and you can delete it.

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
transform. Skipping it would serve an old caller a body in the canonical
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

### And what production has reported since

The adapter also reports how each adapted request and response ended. Point the
gate at that ledger and every later release tells you how the last one is
actually doing:

```ts
createRuntime({ program, identity, onOutcome: (event) => log.append(event) });
```

```sh
invariant check --outcomes invariant/outcomes.jsonl
```

```
  x what production has reported since
      2026-01-15: 18422 requests and 18422 responses adapted, 31 responses failed (0.17%)
      2026-03-01: 902 requests and 902 responses adapted, 0 responses failed (0.00%)
```

It is a rate rather than a count, because a count has nothing to act on: 31
failures out of 18,422 is a real problem and 31 out of 40 is a different one.
A failed response is measured against an objective of 0.01% and a refused
request is not, because a refusal happens before your handler and costs a
retry, while a failed response means the work was done and the caller got an
error for it.

This never blocks. The release you are running is quite possibly the fix.

---

## What each step actually commits you to

Worth being explicit about, because the steps are not the same size and the
large ones are at the end.

| Step | What you install | What you get | Reversible by |
|---|---|---|---|
| 0. Check | nothing | every breaking delta this pull request introduces, named | deleting a file |
| 1-2. Gate in CI | a CI step | the above, on every pull request, as a failing check | deleting a file |
| 3. Changes | text files in your repository | the gate can tell an intended break from an accident | deleting them |
| 4. Adapter | a dependency, two middleware lines | old callers keep working against your new code | reverting a deploy |
| 5. Release | a signing key in CI | a reproducible, signed record of what changed | not publishing |
| 6-7. Operate | a usage sink | a kill switch, and evidence for when to stop serving a contract | turning it off |

Step 4 is the only one that touches a production request path, and it is fifth.
Nothing before it runs anywhere but your CI.

---

## Requirements

- Node 22.12 or later.
- [`oasdiff`](https://github.com/oasdiff/oasdiff) v1.32.x on `PATH`. The gate
  will not run without it rather than checking less than it claims to.
- OpenAPI 3.x. JSON request and response bodies.
