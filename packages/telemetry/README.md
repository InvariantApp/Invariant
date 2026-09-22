# @invariant-app/telemetry

Takes what a running adapter did out of the process, as hourly counters with no bodies and no field values: to the control plane, a rotating JSONL file, or an OpenTelemetry meter. Bounded, and never throws into the request path.

Part of [Invariant](https://github.com/InvariantApp/Invariant), which lets an API
provider change their API without breaking the integrations built against it.
Start with the [quickstart](https://github.com/InvariantApp/Invariant/blob/main/docs/quickstart.md).

Licensed under the Apache License, Version 2.0.
