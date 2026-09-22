---
"@invariant-app/diff": patch
"@invariant-app/proposer": patch
---

A request property that moved into every variant of a choice is no longer reported as removed, and a schema that became a choice is only left undrafted where the variants hold what it lost.
