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
