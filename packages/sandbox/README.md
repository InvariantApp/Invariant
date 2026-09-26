# @invariant-app/sandbox

Runs a consumer migration in two isolated phases. The fetch phase downloads the SDK releases a
migration reads, with install scripts off, and can reach only the package registries, through an
egress proxy that opens tunnels to allowed host names and nothing else. The analyse phase reads the
consumer's repository against those releases with no network at all, read-only inputs, and one
writable output directory. Drivers run the phases in containers (`oci-rootless`, docker or podman),
as Kubernetes Jobs in a sandboxed runtime (`k8s-job`), or in one-shot Fly Machines (`fly-machine`).

`invariant migrate --sandbox oci-rootless` uses it; see the
[CLI reference](https://github.com/InvariantApp/Invariant/blob/main/docs/reference/cli.md).

Part of [Invariant](https://github.com/InvariantApp/Invariant), which lets an API
provider change their API without breaking the integrations built against it.
Start with the [quickstart](https://github.com/InvariantApp/Invariant/blob/main/docs/quickstart.md).

Licensed under the Apache License, Version 2.0.
