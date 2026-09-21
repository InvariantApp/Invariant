# The Go engine

The Invariant runtime's interpreter in Go, held to the same conformance vectors
as the TypeScript reference (`conformance/vectors.json`), so a Go service can
serve old contracts in process with no Node beside it.

It reads numbers as the reference does, as a double written back in its
shortest exact form unless the text holds more than a double can, and keeps
object keys in JavaScript's order: array indexes first, ascending, then the
rest as they were written. Every refusal the vectors name is reproduced,
including the ones made when a program is loaded.

It passes every vector, for bodies, for the request envelope (path, query,
header and cookie parameters beside the body) and for form-encoded bodies
(launch gate L12), and routes and identifies requests as the reference does:
route tables, older base paths, header, URL prefix, principal and default
identity, retired endpoints and the kill switches.

`nethttp.Handler` puts it in front of any `http.Handler`, and is held to the
same suite as the Node adapters: `packages/runtime-node/src/conformance.test.ts`
builds `cmd/conformance-server` and runs every case against it (launch gate
L10b).

```go
runtime, err := invariant.Load(programJSON, invariant.Options{})
if err != nil {
	log.Fatal(err)
}
http.ListenAndServe(":8080", nethttp.Handler(mux, nethttp.Options{Runtime: runtime}))
```

`runtime.AdaptOutbound(contract, "webhook:payment.succeeded", payload, "", "")`
shapes a webhook or callback for a subscriber on an older contract. Adapt, then
sign: a subscriber verifies the signature over the bytes it receives.

A body reads and writes as the same text in either engine: numbers as
JavaScript writes them, keys in JavaScript's order, and strings escaped as
`JSON.stringify` escapes them, which leaves `<`, `>` and `&` alone.

One difference from the Node runtime: a request or response compressed with
Brotli is refused with 415 or 502 rather than adapted, because Go's standard
library has no Brotli decoder. Gzip and deflate are decoded.

```console
cd engines/go && go test ./...
```
