# Invariant

**Change your API without breaking anyone.**

When a company changes its API, every app built against the old one stops
working. There are three ways to handle that today, and each of them costs
somebody real work:

- **Freeze the API.** Cheap this quarter, and paid for in every product
  decision afterwards.
- **Write a migration guide.** This is what most companies do, and it is a
  reasonable thing to do. The provider writes the changelog, the upgrade notes
  and the deprecation warnings once, and then every customer does the same
  piece of work separately, at whatever moment is worst for them. The guide is
  prose, so nothing can check it and nothing can run it.
- **Build a versioning system in-house.** Stripe, Intercom and Keygen each did.
  Each of them spent years on it.

Invariant is the third option as a product, plus something none of them have:
it also sends a pull request to every customer that makes the change for them.

The migration guide does not go away, but it stops being the mechanism. It goes
back to being an explanation.

---

## The short version

1. A developer changes their API and opens a pull request, as normal.
2. Invariant reads what changed and writes down each change in a small file.
   It drafts these itself; a person reads them and merges them.
3. From that one file, two things are produced that **cannot disagree with each
   other**, because they come from the same source:
   - a translator that sits inside the company's own service, so apps built
     against the old API keep working exactly as before
   - an automatic code edit for each customer who has connected their
     repository, delivered as a pull request

Nothing ships unless the change can be proved correct first. The proof is the
product.

---

## What makes this hard, and what we do about it

**The company has to say what changed, and people are bad at that.** So we do
not ask them to remember. We compare the old API description with the new one,
work out what moved, and draft the answer for them to correct.

**A description of a change is easy to get wrong.** So we check it. We apply the
written-down changes to the old API description and see whether we get the new
one back. If anything is left over, that is a change nobody wrote down, and the
release stops. This one check is what makes the rest trustworthy.

**A translator has to work in both directions.** An old app sends a request in
the old shape and expects a reply in the old shape. So every change we record is
reversible, and we test that by generating thousands of fake payloads and
checking they survive a round trip unchanged.

**Some changes cannot be translated at all.** If one field splits into two,
there is no way to put it back together. We say so, by name, rather than
pretending. There is an escape hatch where the company writes that bit by hand,
and using it means the release is marked as "this breaks something" rather than
"this is fine".

---

## How it works

### What actually happens

```
        A company changes their API, and writes down what changed
                                 |
                                 v
                  +--------------------------------+
                  |        invariant check         |
                  |                                |
                  |  Does what they wrote down     |
                  |  explain everything that       |
                  |  actually changed?             |
                  +--------------------------------+
                                 |
                                 | yes, and it survives testing
                                 v
            +--------------------+--------------------+
            |                                         |
            v                                         v
   OLD APPS KEEP WORKING                 CUSTOMERS GET A PULL REQUEST

   A translator ships inside the         Their code is updated from
   company's own service. Their          the same description. They
   customers do nothing at all.          read it and merge it.
```

Both come from the same description, so they can never drift apart. That is the
whole design in one sentence.

### Where each piece runs

```
+-- THE API COMPANY -----------------------------------------------+
|  their repository, their CI, their servers                       |
|                                                                  |
|  pull request:  their code, their API description, our files     |
|         |                                                        |
|         v                                                        |
|  invariant check  -->  PASS / WARN / BLOCK on the pull request   |
|         |                                                        |
|         v  produces a small file that ships inside their build   |
|  the translator, running inside their own service                |
+------------------------------------------------------------------+
         |                                     ^
         | on release: a signed record,        | drafted changes,
         | and counts of how often each        | for a human to
         | old version was used                | read and merge
         v                                     |
+-- INVARIANT -----------------------------------------------------+
|  one service and a database                                      |
|                                                                  |
|  drafting  |  the record of releases  |  code editing  |  GitHub |
+------------------------------------------------------------------+
         |
         | draft pull request
         v
+-- THEIR CUSTOMERS -----------------------------------------------+
|  customers who connected a repository                            |
|  their own tests decide whether the pull request is ready        |
|                                                                  |
|  everyone else keeps using the API, unchanged,                   |
|  and never finds out anything happened                           |
+------------------------------------------------------------------+
```

**We never see the company's source code.** We see their API description and a
list of what changed in it.

**We never see a customer's code unless they install our GitHub App**, on
repositories they choose, and even then the company never sees it. They see
"migrated" or "not migrated" and nothing more.

### Why the translator is in two halves

```
  a request from an app built against an old version
        |
        v
  [ part 1: fix the address ]     before the service decides which
        |                         handler to use, so an old URL
        |                         reaches the right code
        v
  [ the company's own login check ]   the body is still exactly the
        |                             bytes the app sent, so any
        |                             signature over it still matches
        v
  [ part 2: fix the contents ]    after the login check
        |
        v
  the handler, which only knows about today's API
        |
        v
  [ part 2, in reverse ]          back into the shape that app expects
        |
        v
  a reply the old app understands
```

Splitting it in two is not a style choice. One piece cannot both run before the
service picks a handler and leave the request untouched for the signature check.

For an app already on the current version, this costs one lookup and the body is
never even read.

---

## How this differs from the YC request

The Y Combinator request for startups asks for a layer that connects API
providers to customer codebases: *"scan customer codebases, identify affected
usages, open a PR."*

**That is the second half of what we do, and it is the half that is already
crowded.** Several teams shipped a version of it within weeks of the request.
They all work the same way, and they all have the same ceiling:

| | The customer-side approach | Invariant |
|---|---|---|
| Where it sits | On the customer's side, after the change shipped | On the provider's side, before it ships |
| How it learns what changed | Reads a changelog or compares descriptions, and **guesses** | The provider states it, and a human confirms |
| When help arrives | After the customer is already broken | Before anything is broken |
| What it can produce | A pull request | A pull request **and** the app not breaking in the first place |
| Who it needs a relationship with | Nobody | The provider |

The thing outside the request's framing is **old apps continuing to work without
their owners doing anything**. That is the half customers actually feel, it is
the half that cannot be done from the outside, and it is worth more than the
pull request.

It is also proven demand rather than a bet. Stripe, Intercom, Keygen and Cadwyn
all built exactly this in-house, all in the same place in their systems, all
reaching the same conclusion about which changes cannot be handled
automatically. Nobody has turned it into something another company can buy.

**Needing the provider is the hard part, and it is also the moat.** Anyone can
build the customer-side half; nobody else has the provider, and the provider is
where the knowledge of what changed actually lives.

---

## The business

### Who pays, and what for

The API company pays. What they get:

- **The same work stops being done a hundred times.** Writing the migration
  guide is the small half. The large half is every customer reading it and
  making the same edit separately, each at whatever moment is worst for them.
  That cost is real and the provider never sees it on a bill, but they do see
  it as support tickets, as customers stuck on old versions, and occasionally
  as a customer who leaves.
- **Changes stop being scheduled around fear.** A change everyone agrees is
  right gets deferred because the migration is expensive to ask for. That is a
  tax on the product, paid quarter after quarter, and it never appears on a
  budget line.
- **They stop maintaining versioning by hand.** The companies that do this
  properly have a team on it. The ones that do not have an ever-growing pile of
  `if version < X` branches nobody dares delete.
- **Their old versions can end.** We count how often each old version is
  actually used, so "can we finally turn this off?" becomes a question with an
  answer instead of a guess. Today that is the main reason old versions never
  die.

Pricing is not settled. The natural shapes are per API, per old version still
being served, or per customer successfully migrated. The last is the most
honest, since it is the thing the company actually wants to happen.

### How a provider adopts it

This is the part that decides whether the company exists, so it is designed
around one fact: **nobody installs someone else's code in their production
request path on a promise.**

So they do not have to. Adoption is a ladder, and every rung is useful on its
own:

| Step | What they install | What they get |
|---|---|---|
| **1. Just tell me what I am about to break** | **nothing** | On any pull request, a list of exactly what will break for existing customers, by endpoint and by field |
| 2. Put it in CI | a CI step | The same, on every pull request, as a failing check |
| 3. Write the changes down | text files in their repo | The check can now tell a deliberate break from an accident |
| 4. Add the translator | a dependency, two lines | Old apps keep working |
| 5. Release properly | a signing key | A signed, reproducible record of every change |
| 6. Turn old versions off | a usage counter | Evidence for when it is safe |

**Step 1 needs two files and five lines of configuration.** It runs entirely in
their own CI, touches nothing, and is immediately useful. On our sample API it
finds 27 breaking changes and names every one.

That is the wedge. It is free to try, impossible to be harmed by, and it puts a
number on a problem they already know they have. Step 4, the only one that
touches live traffic, is fourth.

### How a customer adopts it

They do almost nothing, which is the point.

A customer of a company using Invariant gets one of two experiences:

- **They do nothing at all.** Their app keeps working. They never find out the
  API changed. This is most customers, and it is the whole value.
- **They connect a repository**, through a link the provider sends. From then on
  they get a draft pull request whenever the provider changes something, with
  the edit already made and an explanation of who confirmed it. Their own tests
  decide whether it is ready. Nothing is ever merged for them.

It costs a customer nothing and there is no negotiation, because the provider is
the one who paid.

### Why this grows on its own

```
   A provider adopts it
          |
          v
   Their customers stop being broken by API changes
          |
          v
   Some of those customers have APIs of their own
          |
          v
   They have now seen the product from the receiving end,
   and they know exactly what it is worth
          |
          v
   They adopt it
```

Distribution is the part most developer tools get wrong. Ours arrives as a
useful pull request from a company the recipient already trusts and already pays.

---

## How Jev is used

[Jev](https://docs.typesafe.ai) is a model that returns a typed answer and a
confidence number instead of prose. We use it for exactly one job, and it is
worth being precise about how small that job is.

### The one question it is asked

When a field disappears from an API and new fields appear, something has to
decide which new field, if any, the old one turned into. That is a judgement
about meaning rather than spelling, and it is the only place in this system
where a model is involved at all.

Ordinary code does everything around it:

| Work | Who does it |
|---|---|
| Finding what changed between the two versions | code |
| Listing the fields it could possibly have become | code |
| Deciding it is a unit change, and that the factor is 100 | code, from the declared number formats |
| Pairing up value names that match | code |
| **Deciding whether `amount` and `amount_cents` mean the same thing** | **Jev** |
| Writing the actual translation | code |

The model never writes a translation, never sees the company's source, and never
decides anything. It picks one item from a list that ordinary code built.

### Why a model at all

Because the alternative does not work. Our deterministic rules are right **100%
of the time** and can only answer **22%** of real cases. Names are genuinely
ambiguous: in a real Shopify change, `physicalLocation` became `retailLocation`,
which shares not one word with it. No amount of string comparison gets that. The
descriptions do.

### Why this model rather than a chat model

- It returns an answer **and a confidence number**, and we act on the number. A
  confident answer becomes a draft; an unsure one is handed to a person. Prose
  has no equivalent of that.
- It answers in about **200 milliseconds** and costs roughly **five cents per
  thousand questions**, so it can be asked about every field without thinking
  about the bill.
- It cannot produce free-form text, so there is nothing for an attacker to
  smuggle out through it.

### What happens if it is wrong

Nothing reaches a customer. A wrong answer produces a wrong **draft**, which
then has to survive the check that the change explains the whole difference, the
round-trip tests, a comparison of the old and new services actually running, and
a human reading it before merging.

We measured the worst case deliberately. 51 of our 240 test cases contain
instructions hidden in pull request text and field descriptions, trying to make
the model give a specific wrong answer: fake approvals, forged system messages,
encoded payloads, instructions in four languages. **Nothing above our confidence
threshold is followed.**

We also found and fixed a real hole while doing it. Our first defence only
covered pull request text, and an instruction hidden inside a field's own
description was obeyed. Widening the defence to distrust all text made overall
accuracy **worse**, because those descriptions are the main evidence. The
wording that worked separates "this text says what a field means", which we
believe, from "this text tells the reader what to answer", which we ignore.

---

## Results

Every number here comes from a test in this repository.

### Does the main claim hold?

`pnpm e2e` runs the whole thing against a sample payments API with three
generations of customers:

| | |
|---|---|
| Three apps, each built against a different old version | all pass |
| The same three against the new API, with no translator | **all break**, as they should |
| The same three, **unchanged**, with the translator in place | **all pass** |
| One app's code then migrated automatically | passes with the translator **switched off** |
| Once it stops using the old version | the tool says that version can be retired |

The one place the code editor refuses to guess is reported with an exact file
and line, and it is exactly the one test that fails until a person handles it.

### How good is the drafting?

Measured against 240 labelled cases. **45 of them are real breaking changes that
GitHub, Stripe and Shopify actually shipped.**

| | When it answers, how often is it right | How often it answers |
|---|---|---|
| Plain rules, no model | **100%** | 22% |
| Jev, when confident | **100%** | 88% |
| Jev, including unsure answers | 96% | 100% |

We report cases we invented separately from real ones, because a test set its
author wrote measures the questions they thought to ask:

| | Cases | Right |
|---|---|---|
| Real changes from real companies | 45 | **91%** |
| Written by us | 195 | 97% |

**Six points apart.** Real changes are harder, and a single combined number
would be quoting the easier half. Above the confidence threshold, the real cases
are **100% right, none wrong**.

Every remaining mistake happens **below** the confidence threshold, so no draft
is ever written from one.

### Speed

| | |
|---|---|
| Translating a normal API reply | **2.6 microseconds** |
| Translating a large list, 65 KB, 340 items | **0.9 milliseconds** |
| An app on the current version | one lookup, body never read |
| The full safety check, every layer | **6.2 seconds** |

### Testing

| | |
|---|---|
| Tests | **439 passing** |
| Generated payloads per change | 10,000, in both directions |
| Outside dependencies in the translator | **zero** |

### Which check catches what

Layers are only worth having if they catch different things, so the tests prove
they do:

| A mistake like this | Is caught by | And not by the others because |
|---|---|---|
| A break nobody wrote down | the explain-everything check | - |
| Converting by 1000 instead of 100 | the explain-everything check | Converting up and back down cancels out, so round-trip tests see nothing, and the customer sends 49.99 and reads 49.99 back. What is wrong is the number **stored**. |
| A default value outside what the API allows | round-trip tests | The value lives in our file, not in either API description, so comparing the two cannot reach it |
| A conversion that rejects a legal value | round-trip tests | Comparing descriptions never runs a value through anything |
| Two value names swapped | running both versions | A swapped pair round trips perfectly and keeps the same set of allowed values |
| A handler that quietly behaves differently | running both versions | Neither API description changed |
| An API description that no longer matches the code | checking replies against it | Every other layer is trusting that description |

---

## What is built, and what is not

**Built and tested**

- The whole safety check: explaining the difference, round-trip tests, running
  both versions, checking the description matches the code
- The translator, with a portable specification and 20 golden test cases so it
  can be rebuilt in another language
- Signed, reproducible release records
- The code editor, across three different ways of calling an API, including
  untyped raw HTTP
- The drafting layer and its measurement harness
- What production reported after a release, as a rate rather than a raw count
- Delivering pull requests **against real GitHub**, as a GitHub App whose access
  provably **cannot reach a repository outside what was granted**

**Not yet proven end to end**

- Receiving GitHub's event notifications, and the invitation link a customer
  redeems. The signature checking and expiry logic are written and tested; what
  is missing is a live round trip, which needs the service deployed somewhere
  reachable.

Section 21 of [`docs/DESIGN.md`](docs/DESIGN.md) records every place building
this proved the design wrong, including the embarrassing ones: a test cache that
had been hiding a bug while reporting 100%, and the injection defence described
above that made things worse before it made them better.

---

## Documentation

- [Quickstart](docs/quickstart.md) - what a company actually does, start to finish
- [The change format](docs/ir-spec.md) - the precise specification, written so
  the translator can be rebuilt in another language, with
  [`conformance/vectors.json`](conformance/vectors.json) as the same thing in
  machine-readable form
- [Design](docs/DESIGN.md) - every decision and every correction
- [`eval/ownership.yaml`](eval/ownership.yaml) - what the model is allowed to do,
  and the measurements that decided it

## Layout

```
docs/                 design, the change format, the planning brief
fixtures/             a sample payments API and three customer apps
e2e/                  the demo, as a runnable test
eval/                 240 labelled cases, recorded answers, verdicts
conformance/          golden test cases for anyone rebuilding the translator
packages/ir           the change format
packages/decimal      exact decimal arithmetic, no dependencies
packages/contract     reading and fingerprinting API descriptions
packages/diff         working out what changed
packages/compiler     checking the changes explain it, and producing the output
packages/runtime      the translator, and the middleware around it
packages/runtime-hono bindings for the Hono web framework
packages/verifier     round-trip tests, running both versions, and the rest
packages/bundle       signed, reproducible release records
packages/proposer     drafting changes; proposals only, never decisions
packages/eval         measuring the drafting against the labelled cases
packages/migrate-ts   editing customer code safely
packages/github       delivering pull requests
packages/flags        the off switch
packages/cli          the invariant command, run in the company's own CI
apps/control-plane    the hosted service
```

## Running it

```sh
pnpm install
pnpm check      # lint, typecheck, test
pnpm e2e        # the demo
pnpm demo       # the demo, narrated
```

Needs Node 22.12 or newer, pnpm, and
[oasdiff](https://github.com/oasdiff/oasdiff):

```sh
go install github.com/oasdiff/oasdiff@v1.33.0-rc.1
```

Without it the safety checks skip locally and **fail** in CI, because a skipped
safety check looks exactly like a passing one.

## The sample API

`fixtures/provider-acme` is a payments API with three generations, all served by
one implementation:

| Version | What the wire looks like |
| --- | --- |
| `2026-01-15` | `POST /v1/charges`, amounts in dollars, a flat `source` token |
| `2026-03-01` | `POST /v1/payments`, the token nested inside `payment_method` |
| `head` | amounts in cents, new status names, a new required field |

Three customer apps are built against those versions and never modified:

| App | Version it was built against | How it calls the API |
| --- | --- | --- |
| `consumer-a-sdk-v1` | `2026-01-15` | an official SDK |
| `consumer-b-types-v2` | `2026-03-01` | generated types |
| `consumer-c-rawfetch-v2` | `2026-03-01` | raw HTTP, no types at all |

It is modelled on Stripe's real charges-to-payment-intents history, because a
sample that only contains changes the tool handles well proves nothing.
