# Evolution bundle, version 1

This page is the `predicateType` of every signed Invariant release:

```
https://github.com/InvariantApp/Invariant/blob/main/docs/evolution-bundle-v1.md
```

A release is published as an [in-toto Statement](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
whose predicate is the evolution bundle described here, wrapped in a
[DSSE](https://github.com/secure-systems-lab/dsse/blob/master/envelope.md) envelope and signed with
Ed25519. Anything that verifies in-toto attestations can check who signed a release without
knowing anything about API evolution; this page says what the predicate means.

## The envelope

```json
{
  "payloadType": "application/vnd.in-toto+json",
  "payload": "<base64 of the canonical JSON statement>",
  "signatures": [{ "keyid": "sha256:<hex>", "sig": "<base64>" }]
}
```

- The signature is over DSSE's pre-authentication encoding of the payload type and the payload
  bytes, so it cannot be moved onto a document of another type.
- `keyid` is `sha256:` and the hex SHA-256 of the signing key's public half in SPKI DER form. It
  is computed, never chosen.
- The payload is the statement serialized as canonical JSON ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)).

## The statement

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "name": "<api>/<to label>", "digest": { "sha256": "<hex>" } }],
  "predicateType": "https://github.com/InvariantApp/Invariant/blob/main/docs/evolution-bundle-v1.md",
  "predicate": { "...": "the bundle, below" }
}
```

The subject's digest is the SHA-256 of the canonical JSON of the predicate itself, so the
statement is about one exact bundle.

## The bundle

| Field | Meaning |
|---|---|
| `bundleVersion` | `1`. A reader refuses any other. |
| `api` | The API's name, as its runtimes and the hosted service know it. |
| `from`, `to` | The contract this release replaces and the one it introduces: `{ "label", "digest" }`, where the digest is of the contract's specification. |
| `source` | Where the release was built from: `{ "repo", "commit", "pr"? }`. |
| `changes` | Every Change in this step, in the order they apply going forward. The Change format is the [IR specification](ir-spec.md). |
| `evidence` | What the release gate ran and what it found, sorted by kind, subject and inputs digest. |
| `compiled.programDigest` | The digest of the compiled program, without who compiled it. |
| `gate` | `{ "result": "pass" or "warn", "unexplained": [...] }`. A blocked release is never bundled. |

Nothing derived from the moment of building, such as a timestamp or a host name, is part of the
bundle. The same repository at the same commit therefore produces the same bundle and the same
digest, and `invariant verify --rebuild` checks a published bundle that way rather than on trust.

## Verifying

1. Check a signature against a public key you trust: the publisher's, from the
   [`/.well-known/invariant.json`](well-known.md) they serve on their own domain, their dashboard
   or their own documentation.
2. Check `predicateType` is this page's address and `bundleVersion` is `1`.
3. Check the subject's digest is the digest of the predicate you were given.

`invariant verify <bundle> --key publisher.pub` does all three.
