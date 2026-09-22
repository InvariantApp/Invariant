---
"@invariant-app/diff": minor
"@invariant-app/proposer": minor
"@invariant-app/compiler": minor
"@invariant-app/ir": minor
---

The release gate explains more of what real APIs do.

- Two spellings of one schema are no longer a breaking change: `const: x` and `enum: [x]`, and a list of values written in place or as a named schema, compare as the same before the differ runs.
- A schema renamed or written out in place where it was used is matched through the property that refers to it, so the fields it lost are drafted instead of reported with nothing to explain them.
- A field dropped beside fields that were added is drafted as dropped, for explicit review, where no judge would pair it with one of them.
- `remove` may leave out `restore`: old callers' requests drop the field and their responses are left without it, which the compiler allows only where their contract never promised it.
