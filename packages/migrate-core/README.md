# @invariant-app/migrate-core

The part of a consumer migration that is the same in every language: the plan built from a release's Changes, byte-range edits that nest, and the sites a migration shows to a person instead of rewriting. Each language pack (`@invariant-app/migrate-ts`, `@invariant-app/migrate-py`, `@invariant-app/migrate-go`) finds references, classes their roles and writes edits in these terms.

## The conformance suite

Every pack is held to the same scenarios, kept in [`conformance/migration/`](https://github.com/InvariantApp/Invariant/tree/main/conformance/migration): 65 situations a consumer's code can be in when a Change reaches it, such as a renamed field read through an alias or a re-export, bound by destructuring or unpacking, read from a dictionary or map by key, behind an optional chain or in a list's items, written into a request, reached through a generated SDK or a hand-written one, or a field of the same name that is not the SDK's at all. `scenarios.json` says once, in no language, which Changes each scenario applies and what a migration must do: rewrite exactly (`edit`), show a person the stated place and change nothing (`flag`), or leave it alone (`none`).

Each language keeps an SDK and one fixture per scenario under `conformance/migration/<language>/`, written the way that language's consumers write it. Beside each file an `edit` rewrites is its golden copy (`main.go.golden`), and each line a `flag` must show carries a `<- flag` comment. Each pack's `conformance.test.ts` migrates every fixture on its own with the scenario's Changes and hands the result to the shared harness (`harness.ts`), which judges every pack by the same reading. The suite measures what the Changes determine; the check against the upgraded release, which reports whatever else stops compiling, is each pack's own to test.

Where a pack does not yet do what a scenario asks, the manifest records a gap under that language, with what the pack does instead and a one-line reason, and the pack's test asserts the gap is still there. The expectation is never weakened to fit a pack, and a pack that closes a gap fails until the gap is removed, so the manifest is always each pack's true standing. Naming a file in `INVARIANT_CONFORMANCE_REPORT` writes every verdict to it as a line of JSON, the quickest way to see what a pack does across the whole suite.

A fourth language adds itself as a checklist:

1. Add it to `LANGUAGES` and its source extension to the harness, and write an SDK for it under `conformance/migration/<language>/` that declares the contract the manifest describes, in the shape that language's SDKs have.
2. Write a fixture for every scenario, with its goldens and marks. The manifest's own test, here in `migrate-core`, lists each one still missing.
3. Add a `conformance.test.ts` to the pack that migrates each fixture with `changesOf(manifest, scenario)` and passes the result to `expectConformance`.
4. Record every scenario the pack does not yet meet as a gap, with what it does instead and why.

Part of [Invariant](https://github.com/InvariantApp/Invariant), which lets an API
provider change their API without breaking the integrations built against it.
Start with the [quickstart](https://github.com/InvariantApp/Invariant/blob/main/docs/quickstart.md).

Licensed under the Apache License, Version 2.0.
