# Go net/http

The Go engine runs the same programs as the TypeScript runtime and passes the
same conformance vectors and adapter suite, so a Go service serves old
contracts in process with nothing beside it.

## Serve old contracts

```sh
go get github.com/InvariantApp/Invariant/engines/go
invariant compile   # writes invariant/compiled/program.json
```

```go
program, _ := os.ReadFile("invariant/compiled/program.json")
runtime, err := invariant.Load(program, invariant.Options{})
if err != nil {
	log.Fatal(err)
}
http.ListenAndServe(":8080", nethttp.Handler(mux, nethttp.Options{Runtime: runtime}))
```

A program this engine cannot run in full is refused when it loads, never run in
part.

## The kill switch

`Options.Flags` is asked on every request and must answer at once; keep the
current switches in memory and refresh them in the background from the
service's `GET /v1/flags` (a token with `flags:read`, sending the last
`ETag` so an unchanged answer costs nothing), or from a file:

```go
var current atomic.Value // invariant.Flags
current.Store(invariant.Flags{})
runtime, err := invariant.Load(program, invariant.Options{
	Flags: func() invariant.Flags { return current.Load().(invariant.Flags) },
})
if err != nil {
	log.Fatal(err)
}
http.ListenAndServe(":8080", nethttp.Handler(mux, nethttp.Options{Runtime: runtime}))
```

## Report usage

`Options.OnOutcome` receives each adapted request and answer, to count and
send to `POST /v1/ingest` (a token with `ingest`). Per-consumer usage, which
is what says an old contract can be retired, is not yet reported by the Go
engine; until it is, run the [proxy](proxy.md) in front of a Go service that
needs it, or report from your own middleware by the consumer key you already
identify callers with.
