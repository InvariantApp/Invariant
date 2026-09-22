---
"@invariant-app/contract": minor
"@invariant-app/diff": patch
---

An empty `enum`, `oneOf` or `anyOf` is read as no list at all, and a union of constants typed once on the union, or with a single branch, or beside a `format`, is read as the enum it is. A response field reached through a map's values that took a list of values is no longer reported as breaking.
