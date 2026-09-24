# Runtime errors

When the runtime refuses a request or cannot express an answer, the caller is
told why in the API's own error shape (by default
`{ "error": { "type", "message", "code" } }`, and a provider can supply its
own), and the answer carries an `Invariant-Error-Id` header. The same id is on
the outcome the runtime reports, so what a caller quotes can be found in your
logs. Nothing below ever reaches your handler with a half-translated body.

The codes are stable once published: a caller may branch on them.

## `invariant_contract_unsupported`

**400.** The request names a contract this API does not serve: a label that
was never released, or one retired from `invariant.yaml`. The message names
the label. The caller should move to a served contract; if it is one you
retired too early, add it back to `spec.released` and compile.

## `invariant_endpoint_retired`

**410.** The operation existed on the caller's contract and no longer exists
at all. The message carries the provider's guidance where the Change gave
some. Nothing can be translated for it; the caller has to move off it.

## `invariant_body_too_large`

**413.** The request needs translating and its body is larger than the
runtime will buffer (`maxBodyBytes`, 1 MiB by default), or nested deeper than
it will walk. A body that needs no translating streams through at any size.

## `invariant_request_not_translatable`

**400.** The request needs translating and cannot be: most often a value the
caller's contract allowed that the current one has no mapping for. Nothing
reached your handler, so refusing has no side effect.

## `invariant_response_not_translatable`

**502.** Your handler answered, and the answer cannot be expressed in the
caller's contract: a value their contract never had. The caller is told so,
never sent an answer in a shape their code was not written for. The request
itself was handled; if it changed something, it did.

## `invariant_upstream_unavailable`

**502** or **504.** The proxy could not reach your service, or your service's
answer broke off before its body was complete (502), or it did not answer, or
finish answering, within `upstreamTimeoutMs` (504). Only the proxy raises it.
An answer the proxy streams unchanged, such as a current caller's, reaches the
caller cut short instead, as it came.

## `invariant_encoding_unsupported`

**415.** The request needs translating and its `Content-Encoding` is one the
runtime cannot decode. A body that needs no translating passes through
encoded.
