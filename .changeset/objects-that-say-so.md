---
"@invariant-app/contract": minor
---

A schema that lists its properties and states no type is read as the object it describes, so a release that finally writes `type: object` is not reported as changing the type of every field that holds one.
