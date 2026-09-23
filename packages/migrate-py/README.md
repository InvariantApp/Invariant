# @invariant-app/migrate-py

Rewrites a consumer's Python code across a release, from the same Changes that drive the runtime. pyright says what each name refers to, tree-sitter says what the code does with it, and an edit is written only where both agree on exactly what to write; everything else is reported to a person with the reason. The result is checked against the release being moved to, and every place that stops type-checking is reported.

The SDK is installed from its wheels only, never built from source, and nothing of the consumer's is run.

Part of [Invariant](https://github.com/InvariantApp/Invariant), which lets an API
provider change their API without breaking the integrations built against it.
Start with the [quickstart](https://github.com/InvariantApp/Invariant/blob/main/docs/quickstart.md).

Licensed under the Apache License, Version 2.0.
