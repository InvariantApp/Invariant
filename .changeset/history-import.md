---
"@invariant-app/cli": minor
"@invariant-app/compiler": patch
---

Retroactive onboarding. `invariant history import <label>=<spec> ...` puts contracts an API served before adopting Invariant in front of the chain, oldest first: each document is snapshotted into `invariant/contracts`, added to `spec.released`, and the Changes between neighbours are drafted with rules only into `invariant/released/<label>`, for a person to answer and `check --full` to compare with the old versions' deployments through a `url` source. `invariant check` now lists what an earlier, released step leaves unexplained, not only the step being built.

A route onto an operation the old contract already serves is refused. The adapter finds its work by where a call lands, so it would have applied one operation's transforms to the other's callers, and closure silently compared the moved operation in place of the one it covered.
