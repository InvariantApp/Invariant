# The proving ground

Everything here exists to answer one question without a design partner: does
this work on real APIs, real traffic and real code that nobody here wrote?

Each rig is a three-arm experiment. The old client against the old server must
pass, or the rig is broken. The old client against the new server with no
adapter must fail, or the pair proves nothing and is excluded. The old client
against the new server through the adapter must pass. Only the third arm is the
product; the first two are what make it mean something.

| Rig | Directory | What it proves | What it cannot |
|---|---|---|---|
| A. Real specifications | `corpus/` | The pipeline survives, and how much of what real providers actually do it can explain, across a pinned corpus of published version pairs. | Whether an explanation is semantically right. That is rig B, C and D's job. |
| B. Official SDK suites | `sdk-suites/` | An official SDK's own test suite, pinned to an old API version, passes unmodified against the new specification through the proxy. | Anything the mock does not model, such as state. |
| C. Generated traffic | `traffic/` | For every pair whose Changes close, requests the old contract allows are accepted by the new one after translation, and responses translate back into the old contract, checked by a validator that is not this project's. | Behaviour, as opposed to shape. |
| D. Real servers | `servers/` | Real open-source servers, across their own breaking releases, behind the proxy, with the previous release's own tests passing. | Providers whose releases are not published as images. |
| E. Migration replay | `replay/` | The migration engine's edits against the edits humans actually made when they upgraded an SDK. | Code nobody published. |
| F. Hostile input | `fuzz/` | The runtime, the proxy and the parsers survive input designed to break them. | Anything not fuzzed. |
| Long chains | `chains/` | A 50-step chain over a Stripe-sized, generated API stays within stated budgets for program size, compile time, load time and p99 transform (L18), and means what its steps run in turn mean. | The cost of a real provider's history, whose steps reach fewer sites than these. |

## Rig A: the corpus

`corpus/manifest.json` pins every specification by a URL at an exact commit
and its sha256. Nothing is measured that does not match, so a change in a
number is a change in the system rather than in the documents.

```console
pnpm proving:corpus                          # every pair; writes the report
pnpm proving:corpus --provider stripe.com    # one provider; results only
pnpm proving:corpus --shard 0/4              # one CI shard; results only
node --import tsx proving/corpus/run.mts --report a.json b.json   # merge shards
pnpm proving:discover                        # add newly published pairs
```

Specifications are downloaded into `.cache/corpus/`, named by hash, and never
committed. They belong to the providers who wrote them.

### Swagger 2.0, checked by a second converter

Docker Engine, Gitea, Slack and Kubernetes publish Swagger 2.0, which every
load converts to OpenAPI 3.0. Both halves of a pair go through the same
converter, so a conversion mistake would agree with itself and be invisible.
`swagger/oracle.mts` converts every 2.0 document in the manifest a second way,
with `swagger2openapi`, and compares the two results with the differ the gate
uses. Each difference is read against the 2.0 source: where ours was wrong it
is corrected in `packages/contract/src/swagger.ts` with a regression test, and
where the other converter was wrong the reason is written into the oracle, so
only a difference nobody has looked at fails the run. `swagger/REPORT.md` is
the latest result.

It found three mistakes of ours in the first run, across more than five
thousand differences: an operation's own `produces` lost to the document's,
a form with a required field not making the body required, and Docker's
`x-nullable` read as nothing. Slack's document is refused rather than
compared: it writes `items` as a list, which neither 2.0 nor 3.0 allows, and
the loader now says where instead of the differ failing with an exit code.

## Rig C: generated traffic

For every pair the recorded corpus run found closing, the Changes are drafted
again, compiled into a program, and loaded into the real proxy. Each adapted
site gets 100 seeded requests shaped by the old contract, sent to a mock of
the old API, to a mock of the new one, and to the new one through the proxy.

```console
pnpm proving:traffic                                   # every closing pair; writes the report
pnpm proving:traffic --provider googleapis.com         # one provider; results only
pnpm proving:traffic --api adyen.com:TerminalAPI-v1 --samples 20
```

`traffic/mock.mts` answers from a contract alone, and `traffic/oracle.mts`
judges every body with Ajv, which shares no code with the product. A sample
the rig cannot judge, because the old mock could not produce a valid value of
its own contract, is counted and explained in the report rather than passed.
Retired operations are scored only against what was declared: a 410, and the
API never reached. A violation fails the run.

## Rig D: real servers

`servers/projects.json` names each project, pins every release by its tag's
commit and its image digest, and lists the release pairs to run. For each
pair the old release's own API suite, validating against the old
specification, runs against the old server, the new server, and the new
server through the proxy running the drafted program, each from a fresh
container.

```console
pnpm proving:servers --project qdrant
node --import tsx proving/servers/run.mts --project qdrant --pair v1.13.0:v1.14.0 --select test_alias
```

Needs Docker and `uv`. The suite is installed from the release's own lock
file into a virtual environment of its own. A test that passes without the
adapter and fails through it fails the run.

## Rig F: hostile input

`fuzz/` holds properties that must hold for any input at all: the program
decoder, the interpreter, path templates and the proxy either answer or
refuse with their own typed error, never throw anything else, never answer
with a 500 of their own, and never touch `Object.prototype`. Every commit runs
them with a few hundred cases; the nightly run with 200,000.

```console
pnpm exec vitest run proving/fuzz
FUZZ_RUNS=200000 FUZZ_SEED=-900866067 pnpm exec vitest run proving/fuzz   # replay a failure
```

A counterexample is fixed where it broke and kept there as a regression test.
The first deep run found three: a number a double cannot hold was forwarded
as `null`, a cast of a value it could not express threw an untyped error, and
a number kept with its original digits was treated as an object.

## Rig E: migration replay

`replay/index.json` lists merged pull requests where a bot bumped an SDK
across a major version and humans edited source files on the same pull
request: the call-site fixes the migration engine is replayed against. It
holds the repository, both commits, the package, versions, licence and the
files touched, and never the code. Only permissively licensed repositories
that are not forks are indexed.

```console
GITHUB_TOKEN=... node --import tsx proving/replay/mine.mts --months 36 --limit 150
GITHUB_TOKEN=... node --import tsx proving/replay/mine.mts --package github.com/google/go-github
```

The nightly run adds up to 150 cases. Replaying them, and scoring the
engine's edits against the humans', follows once the engine reads code it did
not write (M6).
