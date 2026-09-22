---
"@invariant-app/proposer": patch
---

A field pointed at another schema is read only where the schema it pointed at is itself unchanged, so a difference drafted under that schema's own name is not drafted a second time.
