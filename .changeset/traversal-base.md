---
"@invariant-app/sidecar": patch
---

A path whose escaped slashes hide a step up is refused only where the proxy fronts a base path it would leave. In front of a whole server there is nothing outside to reach, and the server's own answer is the one its callers expect: Qdrant's suite sends `..%2F..%2Fetc%2Fpasswd` for a snapshot and checks for its 404, which the proxy had turned into its own 400.
