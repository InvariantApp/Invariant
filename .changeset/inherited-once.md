---
"@invariant-app/proposer": patch
---

A field a schema inherits through `allOf` is drafted once, where it is declared, rather than once for every schema built from it; and a schema whose name now belongs to a different schema no longer has its fields drafted as dropped.
