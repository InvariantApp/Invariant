// Command invariant-go-migrate reads Go code for the migration engine: what an
// SDK exports, where a consumer refers to it, and what no longer compiles.
//
// It is not gopls. A language server answers one question at a time about a
// file somebody has open; a migration asks the same few questions about every
// file at once, and needs answers an editor never does: the exact object an
// identifier resolves to (`types.Info.Uses` and `Selections`, so a field
// reached through an alias or an embedded struct is still that field), and
// the wire name a struct tag gives each field (`json:"amount"`), which is how
// a Change naming `amount` finds `Charge.Amount`.
//
// One request is read as JSON from standard input and one response written
// to standard output. Nothing here runs the consumer's code: packages are
// loaded for their syntax and types, which compiles dependencies to read
// their export data and executes none of them. The caller sets
// GOTOOLCHAIN=local, GOFLAGS=-mod=readonly, CGO_ENABLED=0 and a GOPROXY
// allowlist in the environment this inherits.
//
//	echo '{"command":"surface","dir":"...","packages":["..."]}' | invariant-go-migrate
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// Request is one question. Which fields matter depends on Command.
type Request struct {
	Command string `json:"command"`
	// Dir is the directory the go command runs in: a module the packages
	// resolve from.
	Dir string `json:"dir,omitempty"`
	// Packages are import paths or patterns, as the go command takes them.
	Packages []string `json:"packages,omitempty"`
	// Targets are the import paths whose objects are reported, by prefix: an
	// SDK's module path covers every package in it.
	Targets []string `json:"targets,omitempty"`
	// Within limits what is reported to files under this directory: the
	// repository, never the module cache.
	Within string `json:"within,omitempty"`
	// Tests loads each package's test files too.
	Tests bool `json:"tests,omitempty"`
	// BuildFlags are passed to the go command, as `-modfile`, which checks
	// the code against a copy of go.mod moved to the new SDK while the
	// consumer's own stays as it is.
	BuildFlags []string `json:"buildFlags,omitempty"`
	// Overlay replaces files' contents as the loader reads them, by absolute
	// path, so edits are checked without being written.
	Overlay map[string]string `json:"overlay,omitempty"`
	// Replaced names methods the SDK removed in favour of another that calls
	// the same operations, by `package:Holder.Method` inside the module, with
	// the parameters whose type the replacement changed. A call to one no
	// longer resolves to anything, so which of its arguments no longer fit
	// cannot be read from the new release's types; this says.
	Replaced map[string][]int `json:"replaced,omitempty"`
	// Files are texts to format.
	Files []FormatFile `json:"files,omitempty"`
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(in io.Reader, out io.Writer) error {
	var request Request
	if err := json.NewDecoder(in).Decode(&request); err != nil {
		return fmt.Errorf("reading the request: %w", err)
	}
	response, err := answer(request)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(response)
}

func answer(request Request) (any, error) {
	switch request.Command {
	case "surface":
		return surface(request)
	case "refs":
		return references(request)
	case "diagnose":
		return diagnose(request)
	case "format":
		return formatFiles(request.Files), nil
	default:
		return nil, fmt.Errorf("unknown command %q", request.Command)
	}
}
