# The Go engine

The Invariant runtime's interpreter in Go, held to the same conformance vectors
as the TypeScript reference (`conformance/vectors.json`), so a Go service can
serve old contracts in process with no Node beside it.

It reads numbers as the reference does, as a double written back in its
shortest exact form unless the text holds more than a double can, and keeps
object keys in JavaScript's order: array indexes first, ascending, then the
rest as they were written. Every refusal the vectors name is reproduced,
including the ones made when a program is loaded.

Done: every vector, for bodies, for the request envelope (path, query,
header and cookie parameters beside the body) and for form-encoded bodies.
Still to come: routing and identity, and `net/http` middleware held to the
Node adapters' suite (launch gate L10b).

```console
cd engines/go && go test ./...
```
