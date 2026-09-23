# @invariant-app/migrate-go

Rewrites a consumer's Go code across an SDK release, from the same Changes that drive the runtime. References are found by the object they resolve to, fields by the wire name their `json` tag gives them, and the result is type-checked against the new release; whatever still does not compile is reported with everything it reaches rather than guessed at.

It runs the go toolchain with `GOTOOLCHAIN=local`, `-mod=readonly`, `CGO_ENABLED=0` and modules only through the proxy, and never runs the consumer's code, tests or generators.

Part of [Invariant](https://github.com/InvariantApp/Invariant), which lets an API
provider change their API without breaking the integrations built against it.
Start with the [quickstart](https://github.com/InvariantApp/Invariant/blob/main/docs/quickstart.md).

Licensed under the Apache License, Version 2.0.
