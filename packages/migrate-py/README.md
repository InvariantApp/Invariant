# @invariant-app/migrate-py

Rewrites a consumer's Python code across a release, from the same Changes that drive the runtime. pyright says what each name refers to, tree-sitter says what the code does with it, and an edit is written only where both agree on exactly what to write; everything else is reported to a person with the reason. The result is checked against the release being moved to, and every place that stops type-checking is reported.

Where the checker cannot type a value, it is followed back through the consumer's own code (assignments, the arguments every call passes to an unannotated parameter, what a function returns, `to_dict()`), and a field read from it by name is certain where the trail ends at the SDK. A dictionary of keyword arguments built before the call it is unpacked into is checked key by key against both releases. Requests made with `requests` or `httpx` are read against the same Changes, given the API's operations.

The SDK is installed from its wheels only, never built from source, and nothing of the consumer's is run.

Part of [Invariant](https://github.com/InvariantApp/Invariant), which lets an API
provider change their API without breaking the integrations built against it.
Start with the [quickstart](https://github.com/InvariantApp/Invariant/blob/main/docs/quickstart.md).

Licensed under the Apache License, Version 2.0.
