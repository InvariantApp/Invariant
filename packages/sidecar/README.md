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

## WebSockets

A request asking to `Upgrade`, a WebSocket among them, is passed to the
upstream with its path, query and headers, and once the upstream agrees the
bytes flow both ways untouched. There is no message after the handshake for a
program to adapt. An upstream that cannot be reached is answered with `502`.

## Metrics

`/__invariant/metrics` serves the proxy's counters in Prometheus's text format:
`invariant_adapted_total`, `invariant_change_applied_total`,
`invariant_refused_total`, `invariant_unsupported_contract_total` and
`invariant_transform_error_total`, labelled by contract, direction, Change and
reason. Never by path, which carries ids. Move it with `"metricsPath"`, or set
it to `null` to pass that path on to your API like any other.

## Access log

`"accessLog": true` writes one JSON line per request to stdout: method, path,
status, milliseconds until the answer began, and the contract and error id
where there is one. Never a body, a query string or a header value, which
carry what callers send.

## TLS and HTTP/2

To have callers reach the proxy over TLS, give it a certificate and key in PEM,
by path relative to the configuration:

```json
{ "listen": { "host": "0.0.0.0", "port": 8443, "tls": { "certFile": "tls/cert.pem", "keyFile": "tls/key.pem" } } }
```

The port then serves HTTP/2 and HTTP/1.1, whichever a caller offers. Some
official SDKs, stripe-go among them, speak only HTTP/2 over TLS. Both files are
read before the port opens, so a missing one stops the start. In the container,
point the health check at the TLS port with
`INVARIANT_HEALTH_URL=https://127.0.0.1:8443/__invariant/health`, and set
`NODE_EXTRA_CA_CERTS` to the certificate if no public authority issued it.

## The kill switch and counters

Both are optional, and neither is ever in a request's path.

```json
{
  "controlPlane": { "url": "https://control-plane.example.com", "tokenEnv": "INVARIANT_TOKEN" },
  "flags": {
    "file": "flags.json",
    "remote": { "cache": "/var/lib/invariant/flags.json", "pollMs": 15000 }
  },
  "telemetry": { "controlPlane": true, "file": "/var/log/invariant/usage.jsonl" }
}
```

- **`controlPlane`** names the environment variable that holds the token, never
  the token itself, and must be `https`. A token variable that is not set is
  refused at startup, so a proxy that never reports cannot pass for one with no
  traffic.
- **`flags`** reads a file, an environment variable (`"env"`), the control
  plane, or any of them at once. A contract or Change switched off in any source
  is off. Remote flags are polled with the tag of what is held and kept in
  `cache`, so a switch flipped during an incident is still on after a restart
  while the control plane is down. The proxy waits up to two seconds for the
  first answer before taking traffic.
- **`telemetry`** sends hourly counters, hashed by consumer and never carrying a
  body or a field value, to the control plane and a heartbeat saying which
  program is running; `file` writes the same counters as JSON lines, rotated by
  size, which `invariant release` reads as runtime evidence.

Every refusal carries `Invariant-Error-Id`, and the proxy writes each refusal
and failure to stdout as a JSON line with the same id, the contract, the
operation and the reason, so what a caller quotes can be found without a body.

## A new program, and limits

The proxy replaces its program while it runs, on `SIGHUP` or when the program
file changes. Requests under way finish on the program they started with. A
new program that does not load, because it is unreadable, half-written or
needs a newer runtime, is reported on stderr and the running one keeps
serving. Changes to `sidecar.json` itself need a restart.

`requestTimeoutMs` (default 120,000) and `headersTimeoutMs` (default 30,000)
bound how long a caller may take to send a request, and `maxConnections`
(default 10,000) how many connections are held at once.
