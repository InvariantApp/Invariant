# The proxy

For a service in any language: a reverse proxy beside each instance, in the
same pod or task, so the program it runs always ships with the build it
fronts.

## Serve old contracts

```sh
docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v ./invariant:/etc/invariant:ro -p 8080:8080 ghcr.io/invariantapp/sidecar
```

It reads `/etc/invariant/sidecar.json`:

```json
{
  "program": "compiled/program.json",
  "upstream": "http://127.0.0.1:3000",
  "listen": { "host": "0.0.0.0", "port": 8080 }
}
```

Listen on every interface inside a container, and make the mounted files
readable by uid 65532, which the image runs as.

## The kill switch

```json
{
  "controlPlane": { "url": "https://invariant-cloud.fly.dev", "tokenEnv": "INVARIANT_TOKEN" },
  "flags": { "remote": { "cache": "/var/lib/invariant/flags.json", "pollMs": 15000 } }
}
```

Polled with the tag of what is held and kept on disk, so a switch flipped
during an incident survives a restart. `"file"` or `"env"` read the same
switches without the service. The token needs `flags:read`.

## Report usage

```json
{ "telemetry": { "controlPlane": true, "file": "/var/log/invariant/usage.jsonl" } }
```

Hourly counters with no bodies and no values, and consumer keys hashed before
they leave. The token needs `ingest`. `/__invariant/metrics` serves the same
counters to Prometheus.
