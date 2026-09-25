---
"@invariant-app/verifier": patch
"@invariant-app/cli": patch
"@invariant-app/compiler": minor
---

`invariant check` fits in memory on Stripe-sized specifications. The lens laws built the generator for a schema in full before drawing a value, one generator for every path through the schemas it reaches, and where nearly every object reaches nearly every other, as Stripe's do through expandable fields, that ran out of a 12 GB heap. A schema's generator is now built the first time a value is drawn from it, and one schema reached along many paths shares one generator per depth. The values drawn, and their shrinks, are the same as before.

The lens laws also finish in reasonable time there. Declared losses are parsed once per schema and removed in one walk, the release's shared blocks are compiled once rather than for every schema, and a law that fails tries at most a thousand smaller values before reporting the smallest it found, saying so when a smaller one may exist. A law on one Stripe object had been shrinking a 1.6 MB value for an hour and a half.

`schemaLenses` returns the lens of any schema of one release, compiling the release's shared blocks once; `schemaLens` is the same for one schema.
