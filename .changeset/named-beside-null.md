---
"@invariant-app/proposer": patch
---

A field that named a schema and became a union of that schema with null, as schemars writes an optional value (`anyOf: [ref, {nullable: true}]`), is drafted as the same field become nullable, with a decision for what old callers are shown, rather than reported as a change of shape no op expresses.
