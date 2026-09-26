# Publishing your signing keys

Your releases are signed. For anyone to check a signature, they need your public key, and they
need to know it is yours. `/.well-known/invariant.json` is how you say so: a small JSON document
you serve from your own domain, listing the APIs you publish and the keys you sign their releases
with.

A consumer who migrates from one of your published releases, with
[`invariant migrate`](reference/cli.md#invariant-migrate) on their own machine or anywhere that
is not the GitHub App, reads the release from the hosted service and your keys from your domain.
The service is only a cache. If it served a release no key of yours signed, whether by mistake,
because someone broke into it, or because someone is impersonating it, the release is refused.
Trust rests on your domain and its TLS certificate, never on our database.

## Make the document

In your repository, with the signing key your CI uses:

```
INVARIANT_SIGNING_KEY="$(cat signing.key)" invariant well-known --out invariant.json
```

or with its public half, and any other key you sign with:

```
invariant well-known --key publisher.pub --out invariant.json
```

It reads the API's id from `invariant.yaml`. Only public keys are ever written. If you publish to
a service of your own, set `INVARIANT_URL` and the document says where your bundles are.

Serve the file at `https://<your domain>/.well-known/invariant.json`, over HTTPS, as
`application/json`. A reader follows a redirect only on the same host and scheme, reads at most
64 KiB, and keeps what it read for at most five minutes (less if your `Cache-Control` says so).

## The format

```json
{
  "version": 1,
  "apis": ["acme-payments"],
  "keys": [
    {
      "keyid": "sha256:9f2c...",
      "public_key": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----\n",
      "added_at": "2026-03-01T00:00:00Z"
    },
    {
      "keyid": "sha256:41ab...",
      "public_key": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
      "added_at": "2025-01-10T00:00:00Z",
      "not_after": "2026-03-01T00:00:00Z"
    }
  ],
  "bundles": { "url": "https://bundles.acme.example" }
}
```

| Field | |
|---|---|
| `version` | `1`. |
| `apis` | The APIs this domain publishes, by the id their releases carry (`api` in `invariant.yaml`). A release for any other API is refused. |
| `keys[].keyid` | `sha256:` and the hex SHA-256 of the key's SPKI DER form, the id a signature names. A document whose id does not match its key is refused. |
| `keys[].public_key` | The Ed25519 public key, in PEM form. |
| `keys[].added_at` | When the key began signing, in RFC 3339 with a zone. A release published before it is refused. |
| `keys[].not_after` | When the key stopped signing. What it signed before stays trusted; a release published after it is refused. |
| `keys[].revoked` | `true` when the key is withdrawn: nothing it ever signed is trusted, whenever it was published. |
| `keys[].revoked_reason` | Why, shown to whoever a release is refused for. |
| `keys[].apis` | The APIs this key signs for, when not every one the document lists. |
| `bundles.url` | Where your releases are published, when not the hosted service. HTTPS only. |

The machine-readable schema is `well-known.schema.json` in `@invariant-app/bundle`. A reader
ignores fields this version does not define, so a later version can add one without breaking
readers already installed; a document written for version 1 has none.

## Rotating a key

Add the new key and stop the old one signing, keeping the document you publish today so nothing
already listed is lost:

```
invariant well-known --from invariant.json --key new.pub --retire sha256:41ab... --out invariant.json
```

The old key gets a `not_after` of now. Releases it signed stay trusted; one published under it
from now on is refused. A key is never dropped by regenerating the document: every key in
`--from` is kept as it was, with its `added_at`, because a key that disappears stops vouching for
everything it ever signed.

## Revoking a key

If a key leaked, revoke it:

```
invariant well-known --from invariant.json --revoke sha256:41ab... --out invariant.json
```

A revoked key vouches for nothing, whenever it signed, because whoever holds it can sign a
release and claim any time they like. Releases it signed that should stay available are signed
again with a key you still trust and published again; revoking it in the dashboard also
withdraws everything it signed from the hosted service.

## When a release was signed

A release carries no time of its own; that is what lets anyone rebuild it and get the same
bytes. So `added_at` and `not_after` are checked against the time the service recorded when the
release was published. The service could misstate that time, which matters only for a key past
its `not_after` that has also leaked, and that key is the one to revoke: `revoked` does not
depend on any time at all.
