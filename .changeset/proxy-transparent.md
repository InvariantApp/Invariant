---
"@invariant-app/sidecar": minor
"@invariant-app/runtime": patch
---

The proxy sends your API the caller's `Host` and no forwarding headers the caller did not send, apart from `X-Forwarded-For` and, where it terminated TLS, `X-Forwarded-Proto`; `"upstreamHost": "upstream"` keeps the old behaviour for an API that routes by its own host name. It calls your API with Node's own HTTP client, so a body sent with a `205` reaches the caller, adapted where the program says so; `responseOf` in the runtime rebuilds a response around any status without dropping its body. Found by running go-sdk's own suite through the proxy to Gitea, whose avatar links and marked notifications both broke.
