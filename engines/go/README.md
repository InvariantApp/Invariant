# The Go engine

The Invariant runtime's interpreter in Go, held to the same conformance vectors
as the TypeScript reference (`conformance/vectors.json`), so a Go service can
serve old contracts in process with no Node beside it.

It reads numbers as the reference does, as a double written back in its
shortest exact form unless the text holds more than a double can, and keeps
object keys in the order they were written. Every refusal the vectors name is
reproduced, including the ones made when a program is loaded.

Done: every body vector. Still to come: the request envelope and form
vectors, routing and identity, and `net/http` middleware held to the Node
adapters' suite (launch gates L10b and L12).

```console
cd engines/go && go test ./...
```
