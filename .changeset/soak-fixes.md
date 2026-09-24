---
"@invariant-app/sidecar": patch
---

Two things the soak found. An answer your service broke off halfway through, one the proxy had to translate for an old caller, was answered 500 as the proxy's own internal error; it is now a 502 `invariant_upstream_unavailable`, or a 504 when the rest came too late. And a request whose body the proxy refused without reading to the end, as it does one over `maxBodyBytes`, held its connection, so the next request the caller sent on it was never answered and the socket stayed open; the rest of such a body is now read and thrown away, so the connection serves the next request.
