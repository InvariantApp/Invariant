# @invariant-app/sidecar

## 0.5.0

### Patch Changes

- 60c5f70: Two things the soak found. An answer your service broke off halfway through, one the proxy had to translate for an old caller, was answered 500 as the proxy's own internal error; it is now a 502 `invariant_upstream_unavailable`, or a 504 when the rest came too late. And a request whose body the proxy refused without reading to the end, as it does one over `maxBodyBytes`, held its connection, so the next request the caller sent on it was never answered and the socket stayed open; the rest of such a body is now read and thrown away, so the connection serves the next request.
- Updated dependencies [eeeb512]
  - @invariant-app/runtime@0.5.0
  - @invariant-app/telemetry@0.5.0
  - @invariant-app/flags@0.5.0
  - @invariant-app/client@0.5.0

## 0.4.0

### Patch Changes

- 407f319: A new op, `status {endpoint, from, to}`, for an operation that answers with another success status: Gitea 1.25 answers the creation of an Actions variable `201` where 1.24 answered `204`, and Immich 1.138 answers `204` where 1.137 answered `200` with nothing. An old caller is answered `from` wherever the operation now answers `to`, and what happens to the body is read from the two contracts: none where the old contract promised none, the body served as any body is where both carry one, and the Change refused where the old status promised a body the new one does not carry. It is exact. A success status removed is now adaptable, and the proposer drafts the op where the documents settle which status replaced which. Programs carry it as a site's `status` rules, which the TypeScript runtime, the Node binding and the Go engine's net/http middleware apply in turn to the provider's status, and which compose across a chain of releases; the response work of a release is filed under the status the provider answers with. A chain now finds each release's response work for a status as the runtime does, by the exact status, then its class, then `default`. A `move` may place a value beneath its own place, as Meilisearch's list of a rule's actions became the `pin` list of an object there, and a field of an object that declares no properties may be moved out of it. The TypeScript runtime now writes a copy of an object a `set` writes, as the Go engine always has, so a later write into one place no longer reaches every place it was written and the program itself. The proxy passes on an empty Host, HTTP/1.1's way of naming no host, where it refused it: Immich's suite sends one to see its share pages fall back to their public address. And a GET that came with a body is sent on without the length of the body it is not sent, where the provider waited for bytes that never came.
- Updated dependencies [5da65b3]
- Updated dependencies [407f319]
- Updated dependencies [ca7c00e]
  - @invariant-app/runtime@0.4.0
  - @invariant-app/flags@0.4.0
  - @invariant-app/telemetry@0.4.0
  - @invariant-app/client@0.4.0

## 0.3.0

### Minor Changes

- 9dc889d: The proxy sends your API the caller's `Host` and no forwarding headers the caller did not send, apart from `X-Forwarded-For` and, where it terminated TLS, `X-Forwarded-Proto`; `"upstreamHost": "upstream"` keeps the old behaviour for an API that routes by its own host name. It calls your API with Node's own HTTP client, so a body sent with a `205` reaches the caller, adapted where the program says so; `responseOf` in the runtime rebuilds a response around any status without dropping its body. Found by running go-sdk's own suite through the proxy to Gitea, whose avatar links and marked notifications both broke.

### Patch Changes

- Updated dependencies [9dc889d]
  - @invariant-app/runtime@0.3.0
  - @invariant-app/client@0.3.0
  - @invariant-app/telemetry@0.3.0
  - @invariant-app/flags@0.3.0

## 0.2.0

### Patch Changes

- 7bb43af: A path whose escaped slashes hide a step up is refused only where the proxy fronts a base path it would leave. In front of a whole server there is nothing outside to reach, and the server's own answer is the one its callers expect: Qdrant's suite sends `..%2F..%2Fetc%2Fpasswd` for a snapshot and checks for its 404, which the proxy had turned into its own 400.
- 80b2b43: A request asking to `Upgrade` no longer lets a caller reach the provider past the proxy. The proxy piped the caller's connection to the provider's as soon as it had forwarded the handshake, so where the provider answered an ordinary route without switching protocols and kept the connection open, as most servers that are not Node's do, whatever the caller sent next arrived there as a request of its own: outside the base path, unadapted, with any `x-invariant-` header it liked. The handshake is now sent on a connection of its own, nothing the caller sends reaches the provider until it answers `101`, and any other answer is relayed and the connection closed. A request to switch to HTTP/2 in cleartext is answered as if it had not asked, since a provider that accepted would take HTTP/2 frames naming any path. A path whose segment decodes to a step up, such as `/api/..%2fadmin`, is refused as leaving the API, and a `Host` no URL can hold is answered 400 rather than 500.
- Updated dependencies [a136b88]
- Updated dependencies [a530d28]
- Updated dependencies [0823e06]
- Updated dependencies [ea463aa]
- Updated dependencies [60a6ebf]
- Updated dependencies [80b2b43]
  - @invariant-app/runtime@0.2.0
  - @invariant-app/client@0.2.0
  - @invariant-app/flags@0.2.0
  - @invariant-app/telemetry@0.2.0
