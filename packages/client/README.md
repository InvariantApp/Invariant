# @invariant/client

The contract of the Invariant control plane, `openapi.yaml`, and a typed client for it with no dependencies: publishing signed bundles, reporting what running adapters did, polling and changing flags, and reading which old contracts are still in use.

The contract is gated by Invariant itself, so a client written against one version keeps working against the next.

Part of [Invariant](https://github.com/InvariantApp/Invariant), which lets an API
provider change their API without breaking the integrations built against it.
Start with the [quickstart](https://github.com/InvariantApp/Invariant/blob/main/docs/quickstart.md).

Licensed under the Apache License, Version 2.0.
