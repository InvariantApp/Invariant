---
"@invariant-app/ir": minor
"@invariant-app/contract": minor
"@invariant-app/compiler": minor
"@invariant-app/proposer": minor
"@invariant-app/diff": patch
---

A new op, `restate {path}`, says the new contract describes the same values another way, such as one object split into a `oneOf` of its kinds. Nothing is transformed and nothing is lost, so the Change stays exact, and the compiler takes it only once it proves, schema against schema, that nothing old callers may now be sent was ruled out for them and nothing they send is refused. `covers` in `@invariant-app/contract` is that proof, and it reads a `discriminator`'s property as required in every branch, as OpenAPI does. The proposer drafts a restatement wherever how a choice is written changed and the proof holds, and leaves out the drafts it makes unnecessary. Figma rewrote a node's `Effect` this way, which left sixty-odd places unexplained in one release.
