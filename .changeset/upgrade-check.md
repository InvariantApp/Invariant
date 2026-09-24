---
"@invariant-app/migrate-ts": minor
"@invariant-app/migrate-core": minor
"@invariant-app/migrate-py": patch
---

The TypeScript pack checks the migrated consumer against the release it moves to, as the Python and Go packs do. Given `upgraded`, where the new release resolves from, it type-checks the consumer's files as they were against the release used today and as the edits left them against the new one, and shows a person each error the upgrade brought, with the checker's own words and the whole statement it is in: a field the new API version no longer sends, a parameter a method stopped taking, a fixture that no longer fits the type it claims. JavaScript is checked the same way, as `checkJs` would, and only what is new is reported. `checkFor` bounds the check in time where the type checker offers to stop, and `checker` runs each check where the caller can stop it outright, such as in a worker it ends at the deadline; a file the check did not reach is listed in the result's `unchecked` rather than holding the migration, and `trace` is told each step as it finishes. The engine itself still starts no process and no thread. `originalOffset`, which places an error in the edited text back where it was read, moves to `@invariant-app/migrate-core` for every pack, and is still exported from `@invariant-app/migrate-py`.

A field a Change moved or removed is also shown where only its name says it may be the contract's: a key of an object literal nothing types, as a test's stand-in for a subscription handed to a mock, or a read or subscript of a value typed `any`, as a webhook's payload. Such a place is never rewritten, as the Python pack does with a dictionary's keys; a use typed as anything else is the checker's to decide.
