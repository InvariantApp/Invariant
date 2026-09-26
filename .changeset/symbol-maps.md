---
"@invariant-app/symbols": minor
---

A new package, `@invariant-app/symbols`, makes the symbol map a migration pack needs from an unpacked SDK release and the OpenAPI document it speaks: which type implements each schema, and which method calls each operation, for TypeScript, Python and Go releases. It reads what the generator recorded first (Stainless, Stripe's own generator, openapi-typescript, openapi-generator, Speakeasy and Fern), then naming conventions, then field overlap at a stated threshold, and hands only what stays tied to a judge, whose default follows fixed rules and never calls a model. Every entry says which of those found it and how sure it is, and maps are cached by package, version and contract digest.
