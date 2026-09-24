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
| Soak | `soak/` | The proxy at a stated rate for 24 hours under upstream stalls, resets, slow, cut and oversized bodies, kill-switch flips, program reloads and restarts, with no response failing the contract its caller named, a bounded memory trend and no leaked sockets (L11). | Load beyond one process at a modest rate, which the overhead rig and a provider's own load tests cover. |
| Proxy overhead | `overhead/` | The proxy adds no more than a stated p99 to an old caller's list response, every item adapted, at a fixed request rate, with the upstream, proxy and client in separate processes (L19). | Overhead on the provider's own hardware, network and body sizes, which a shared CI runner only approximates. |
| Signed webhooks | `webhooks/` | A real GitHub `issues` payload and a real Stripe charge event, from a release that renamed a field, reach a subscriber on the old contract as that contract describes them, and verify under each provider's own signature scheme when signed after adapting and fail when signed before (M4.6). | Every event type either provider sends; two payloads show the order is right, not that every schema is covered. |

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
commit and its image digest (and, where the client lives elsewhere, the
commit of the client that belongs to the release), and lists the release
pairs to run. For each pair the old release's own client or API suite,
unmodified, runs against the old server (arm a), the new server (arm b), and
the new server through the proxy (arm c), each from a fresh container, or a
fresh compose project under `servers/compose/` where the server needs a
database. The suite always calls the same address; in arm c the proxy takes
it and the server sits behind.

The program in arm c is what the product compiles for a provider: a
repository with an `invariant.yaml` naming the two releases' documents, the
Changes committed under `servers/changes/<project>/<from>..<to>/`, and
`invariant check`, which compiles only when the gate does not block. Those
Changes are drafted with the product's own proposer and completed the way a
provider would: decisions answered, with the reason in the file's header,
and what no op serves acknowledged in a `behavior` Change, which the report
counts. A pair with none committed gets what the proposer drafts on the spot.

```console
pnpm proving:servers --project netbox --pair v3.5.9:v3.6.9       # three arms, needs Docker
node --import tsx proving/servers/run.mts --project qdrant --pair v1.16.0:v1.17.0 --propose
node --import tsx proving/servers/run.mts --project qdrant --pair v1.16.0:v1.17.0 --gate
```

`--propose` and `--gate` need no Docker. A project whose document is only
served by the running server is read from a CI run's dump, which each job
uploads with the suite's reports, the gate's report and the Changes it
judged. In CI each release pair is a job of its own, holding no token;
`gh workflow run proving.yml -f rigs=servers -f servers=netbox` runs rig D
alone. A pair the release did not break is reported as vacuous; a test that
passes without the adapter and fails through it fails the run. Projects
looked at and left out are listed in `projects.json` with the reason.

A test a release broke by behavior neither release's document describes, an
error message reworded or a rule for combining states changed, is named
under the pair in `projects.json` with the words it fails with and why no
document names it. It is set aside, and listed with that reason in the
report, only while it fails with those words both without the adapter and
through it, so it cannot hide a different failure or one the adapter caused.
A pair whose every break is of this kind is vacuous.

## The soak

`soak/soak.mts` is L11: the sidecar, exactly as a provider runs it, in front
of an upstream serving the fixture provider's current contract, with the
committed program serving its two released ones, at 50 requests a second for
24 hours. The upstream stalls, resets, cuts bodies short, dribbles them,
answers late and answers with more than the proxy buffers, as each request
asks; the caller sends slow and oversized bodies of its own. Meanwhile the
kill switch is flipped, the program is replaced (every fourth time with one
that does not load), and the proxy is stopped and started again every four
hours. Every response is judged by the rig C oracle against the contract the
caller named, and every body the proxy sends upstream against the current
one; the proxy's memory and sockets are sampled every ten seconds.

```console
capped --mem 600 -- node --import tsx proving/soak/soak.mts --record    # 24 hours
node --import tsx proving/soak/soak.mts --minutes 10                   # the same, compressed
node --import tsx proving/soak/soak.mts --minutes 2 --calm --modes normal,bloated
```

It needs no Docker and holds one proxy and one driver, well under 400 MB, so
it runs on any machine; GitHub's runners stop at six hours. It writes a
checkpoint as it goes to `.cache/soak/<start>/`, and `results.json` at the
end, with each criterion met or not; `--record` also writes
`soak/results.json`, which the scoreboard reads. `--modes` and `--calm` narrow
what goes wrong, to find which disturbance a failure needs. Its first runs
found two things in the proxy: an answer broken off mid-body was answered 500
as its own failure, and a body refused unread held its connection, so the
caller's next request on it was never answered.

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

The nightly run adds up to 150 cases. `--language javascript` searches only
repositories GitHub says are written in JavaScript and caps each package's
cases in that language alone, since npm's bumps are mostly TypeScript
repositories' and L8 counts JavaScript apart. Dependabot never moves a Go
module across a major version, as the version is part of its import path, so
for stripe-go, plaid-go and twilio-go the miner also searches people's own
pull requests that name the SDK.

A bot's bump carries mostly the SDK's own changes; the contract migrations
are often a person's own pull request, titled for the API version it moves
to ("read Stripe fields that basil relocated"). For stripe, plaid-python,
kubernetes and openai on PyPI the miner also searches such titles, reads what
each pull request upgraded from its manifests' diff, and keeps it only where
that moves the SDK forward across a major version.

`replay/run.mts` replays them. Each repository is fetched at the bump's base
with no history and no blob it does not need, the SDK alone is installed at
the version the base's lockfile names, with install scripts off, and the
engine reads the consumer's source against it. Nothing from the repository is
executed. The humans' result and the engine's are both read as the regions
changed from the base, and each human region is identical (the engine wrote
the same lines, whatever the indentation), differs (left for a person to judge
equivalent or wrong), flagged (the engine wrote nothing there and sent a
person to it, which L8 counts as handled, apart from an edit), or missed. What
the engine changed where no human did is counted as extra edits, and what it
flagged where no human changed anything as extra flags: a reviewer's time.

Every npm case, whatever its SDK, is also checked against both releases, as
the Python and Go packs check theirs: the consumer's files that import the SDK
are type-checked as they were against the release used today and as the edits
left them against the new one, JavaScript as `checkJs` would, and every error
the upgrade brought is flagged with the whole statement it is in. An SDK with
nothing else recorded is replayed on that check alone (`verify`).

For Stripe the engine is told what a provider's release would tell it
(`replay/stripe.mts`): each stripe-node release names the stripe/openapi
release it was built from, the proposer drafts the Changes between the two
specifications with the rules judge alone, a removed field no judge paired is
a declared loss, and the symbol map (schemas to types, operations to methods)
is read from the old SDK's own declarations and resource files.

Most of what humans edit on a major bump is the SDK's own interface changing,
not the API's contract: typing, import paths, renamed classes. L8 counts only
the contract sites, so `--classify` has Jev class each site as `contract`,
`sdk` or `unrelated` (`replay/classify.mts`). The classes are model-judged and
labelled as such, kept in `replay/classes.json` without any code, and a sample
is audited by hand before a number from them is quoted.

```console
node --env-file-if-exists=.env --import tsx proving/replay/run.mts --classify
node --import tsx proving/replay/run.mts --package stripe --limit 5 --keep
```

PyPI cases go through the Python pack (`@invariant-app/migrate-py`). The
release each side used comes from the repository's own pins (a requirements
file, a Poetry, uv or PDM lock, a Pipfile lock, a manifest's requirement), or,
where nothing is pinned, from the newest release below the target's major
published before the bump was merged. Both releases are unpacked from their
wheels, with what their metadata requires, and never built from a source
distribution; a release with no wheel is a case that could not be replayed.
pyright reads the files that import the SDK against the old release and
checks the result against the new one, and every error the upgrade brings is
flagged. For stripe-python the pack is also told the Changes, the same way as
for stripe-node, from the OpenAPI release each stripe-python release records.

The Python replay runs in GitHub Actions (`.github/workflows/replay.yml`, four
shards, on every push that touches the pack or the rig), with no token and no
secret, since it fetches and reads strangers' repositories. Its sites are then
classed where the key is, and the run scored again without replaying:

```console
gh run download <run> -n replay-report     # results.json and .cache/replay/sites
node --env-file-if-exists=.env --import tsx proving/replay/run.mts --rescore --ecosystem pypi --classify
```

Go cases go through the Go pack (`@invariant-app/migrate-go`,
`replay/go.mts`). Every Go file, go.mod and go.sum is restored at the base;
the SDK's release comes from the base's go.mod and the release it moved to
from the head's, which is the bump itself. The pack reads the packages that
import the SDK and the packages that import those, moves the imports to the
new major version, renames what the two releases' surfaces show was renamed
exactly, and type-checks the result against the new release; what still does
not compile is flagged with everything it reaches, through the consumer's own
wrappers, interfaces and callers. For go-github the engine is also told which
operations GitHub retired (`replay/gogithub.mts`): each method's
`//meta:operation` names what it calls, and the new release's
`openapi_operations.yaml` marks what GitHub no longer describes. The go command
runs with the installed toolchain, go.mod read-only, no cgo and modules only
through the proxy; it compiles dependencies to read their types and runs
nothing. It replays in the same workflow (`-f ecosystem=go`).

A site the text alone settles is classed by rule (layout, comments, a type
checker told to look away, a Go import moving to the SDK's next major
version), and an answer Jev was unsure of is checked with a second,
independently worded question; `--recheck` applies both to classes recorded
before they existed:

```console
node --env-file-if-exists=.env --import tsx proving/replay/run.mts --rescore --ecosystem go --classify --recheck
```

A site the two questions disagreed about is contested, and counted as
neither. `--settle` asks it a third question, put as the test that separates
the classes: whether a client calling the web API directly, with no SDK,
would have needed the edit too. A sure answer settles the site, labelled
`+settle`; any other leaves it contested. Most contested Python sites stay
contested: stripe-python's `stripe_id` becoming `id`, or a read made safe for
a field its types now call optional, are hard to call from the lines alone.

```console
node --env-file-if-exists=.env --import tsx proving/replay/run.mts --rescore --ecosystem pypi --classify --recheck --settle
```

One case replays on its own in Actions, printing what the engine was told
and did: `gh workflow run replay.yml -f ecosystem=go -f case=owner/repo#123`.

`replay/sites.mts` reads every case's human hunks from the GitHub API, which
is the denominator at a glance without cloning anything.
