---
"@invariant-app/migrate-core": minor
"@invariant-app/migrate-py": minor
"@invariant-app/migrate-ts": patch
---

Python consumers can be migrated. `@invariant-app/migrate-py` reads a Python repository against the SDK release it uses today, through pyright for what each name refers to and tree-sitter for what the code does with it, and writes the edits the Changes determine: a renamed field wherever it is read, set, passed by keyword or written as a key the type checker ties to the SDK, a renamed value where a field is compared with it, and the API version pin (`stripe.api_version`, `stripe_version=`) moved with the SDK. A removed field, a subscript by a field's name and a read the checker cannot type are reported to a person, never edited. The result is then checked against the release being moved to, and every place that stops type-checking is reported with the checker's words, whether or not a Change named it.

The SDK is installed from its wheels only, unpacked and checked against the digest the index publishes; a release with no wheel is refused rather than built. pyright is never pointed at an interpreter, so nothing of the consumer's, and no Python at all, is run.

`@invariant-app/migrate-core` holds what every language pack shares: the migration plan, byte-range edits and the sites shown to a person. `@invariant-app/migrate-ts` re-exports them, so nothing that imports them from there changes.
