---
"@invariant-app/contract": patch
---

A union of a schema and a branch that says nothing but `nullable: true`, which is how schemars and utoipa write an optional value in OpenAPI 3.0, is read as the schema or null, so a Change to the schema is served inside it rather than refused as a union nothing tells apart.
