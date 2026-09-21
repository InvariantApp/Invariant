# @invariant/sidecar

The runtime as a standalone reverse proxy, for providers whose API is not written in Node. `invariant-sidecar --config sidecar.json`.

Part of [Invariant](https://github.com/InvariantApp/Invariant), which lets an API
provider change their API without breaking the integrations built against it.
Start with the [quickstart](https://github.com/InvariantApp/Invariant/blob/main/docs/quickstart.md).

Licensed under the Apache License, Version 2.0.

## Container image

`ghcr.io/invariantapp/sidecar` is this proxy and a Node runtime, on a distroless
base, running as an unprivileged user (uid 65532). It has no shell and no package
manager. Run it read-only with every capability dropped:

```console
docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v ./invariant:/etc/invariant:ro -p 8080:8080 ghcr.io/invariantapp/sidecar
```

It reads `/etc/invariant/sidecar.json` (or `INVARIANT_SIDECAR_CONFIG`), which
names the compiled program, the upstream and the identity strategies. Three
things to get right:

- **Listen on every interface.** Set `"listen": { "host": "0.0.0.0" }`. The
  default, loopback, is unreachable from outside the container.
- **Make the mounted files readable by uid 65532.** A `0600` file owned by
  another user is refused at startup, before the port opens.
- **Tell the health check where to look** if you move the port or the health
  path: `INVARIANT_HEALTH_URL=http://127.0.0.1:9000/__invariant/health`.

The supported shape is one proxy beside each instance of your API, in the same
pod or task, so the program it runs always ships with the build it fronts.
