---
"@invariant-app/verifier": patch
---

Checking a value against an OpenAPI 3.0 contract allows null where the schema says `nullable: true`. The lens laws generated such nulls and then refused them, which blocked any Change touching a schema with a nullable field.
