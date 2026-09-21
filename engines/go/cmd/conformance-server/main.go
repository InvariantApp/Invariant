// Command conformance-server serves the routes the Node adapter suite asks
// every framework for, behind the net/http middleware, so the Go binding is
// held to the same suite as the Node ones (launch gate L10b).
//
//	conformance-server -program program.json
//
// It prints "listening http://127.0.0.1:<port>" once it accepts connections,
// and serves until it is stopped.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"

	"github.com/InvariantApp/Invariant/engines/go/invariant"
	"github.com/InvariantApp/Invariant/engines/go/nethttp"
)

// routes are what every framework's routes do in the suite, written once.
func routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/payments", func(w http.ResponseWriter, r *http.Request) {
		decoder := json.NewDecoder(r.Body)
		decoder.UseNumber()
		var body map[string]any
		if err := decoder.Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		amount, ok := body["amount_cents"]
		if !ok {
			amount = body["amount"]
		}
		status, ok := body["status"]
		if !ok {
			status = "succeeded"
		}
		// Written field by field, so the answer's keys come in the order the
		// other frameworks write them.
		var out bytes.Buffer
		seen, _ := json.Marshal(body)
		amountText, _ := json.Marshal(amount)
		statusText, _ := json.Marshal(status)
		fmt.Fprintf(&out, `{"seen":%s,"amount_cents":%s,"status":%s}`, seen, amountText, statusText)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(out.Bytes())
	})
	mux.HandleFunc("GET /v1/payments/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == `"v7"` {
			w.Header().Set("Etag", `"v7"`)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		text := `{"id":"p_1","amount_cents":1999}`
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", fmt.Sprint(len(text)))
		w.Header().Set("Etag", `"v7"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(text))
	})
	mux.HandleFunc("GET /v1/export", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/csv")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("id,amount\n"))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		_, _ = w.Write([]byte("p_1,1999\n"))
	})
	return mux
}

func main() {
	path := flag.String("program", "", "the compiled program, as JSON")
	flag.Parse()
	text, err := os.ReadFile(*path)
	if err != nil {
		log.Fatal(err)
	}
	runtime, err := invariant.Load(text, invariant.Options{})
	if err != nil {
		log.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("listening http://%s\n", listener.Addr())
	server := &http.Server{Handler: nethttp.Handler(routes(), nethttp.Options{Runtime: runtime})}
	log.Fatal(server.Serve(listener))
}
