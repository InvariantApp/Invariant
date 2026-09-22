---
"@invariant-app/ir": minor
"@invariant-app/compiler": minor
"@invariant-app/proposer": minor
"@invariant-app/diff": minor
---

A value that stopped stating its list of values or its type is declared with `relax` (`enum: null`, `type: null`) where old callers are sent it, and is no longer reported at all where only their requests carry it. `const: x` is read as a one-value list, and a field that stopped referring to a named list is seen as changed.
