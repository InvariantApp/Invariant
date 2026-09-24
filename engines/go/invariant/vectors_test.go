package invariant

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type vector struct {
	Name          string          `json:"name"`
	Instrs        json.RawMessage `json:"instrs"`
	Blocks        json.RawMessage `json:"blocks,omitempty"`
	ProgramBlocks json.RawMessage `json:"programBlocks,omitempty"`
	Input         json.RawMessage `json:"input"`
	MaxMatches    int             `json:"maxMatches,omitempty"`
	Expect        struct {
		Output  json.RawMessage `json:"output,omitempty"`
		Refuses string          `json:"refuses,omitempty"`
	} `json:"expect"`
}

// oldByDefault is the identity the TypeScript harness gives every vector.
var oldByDefault = []Identity{{Kind: "default", Label: "old"}}

type vectorFile struct {
	Vectors []vector `json:"vectors"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "conformance", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file vectorFile
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatal(err)
	}
	return file
}

// programFor builds the program the TypeScript harness builds for a vector: a
// single site whose request list is the vector's instructions.
func programFor(v vector) []byte {
	contract := map[string]any{
		"label":     "old",
		"routes":    []any{},
		"sites":     map[string]any{"post /v": map[string]any{"request": v.Instrs}},
		"behaviors": []any{},
	}
	if len(v.Blocks) > 0 {
		contract["blocks"] = v.Blocks
	}
	program := map[string]any{
		"irVersion":    2,
		"api":          "conformance",
		"current":      "sha256:0",
		"currentLabel": "current",
		"contracts":    map[string]any{"old": contract},
	}
	if len(v.ProgramBlocks) > 0 {
		program["blocks"] = v.ProgramBlocks
	}
	out, _ := json.Marshal(program)
	return out
}

// run returns the output, or who refused: "decode" for a program refused at
// load, the Change's id for a body refused while running, "error" otherwise.
func runVector(v vector) (any, string) {
	runtime, err := Load(programFor(v), Options{Limits: Limits{MaxMatches: v.MaxMatches}, Identity: oldByDefault})
	if err != nil {
		return nil, "decode"
	}
	out, _, err := runtime.TransformRequest("old", "post /v", v.Input)
	if err != nil {
		var transform *TransformError
		if errors.As(err, &transform) {
			return nil, transform.ChangeID
		}
		return nil, "error"
	}
	parsed, err := Parse(out)
	if err != nil {
		return nil, "error"
	}
	return parsed, ""
}

func TestConformanceVectors(t *testing.T) {
	file := loadVectors(t)
	if len(file.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range file.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			output, refusedBy := runVector(v)
			if v.Expect.Refuses != "" {
				if refusedBy != v.Expect.Refuses {
					t.Fatalf("expected a refusal by %s, got %q with output %v", v.Expect.Refuses, refusedBy, output)
				}
				return
			}
			if refusedBy != "" {
				t.Fatalf("refused by %s", refusedBy)
			}
			expected, err := Parse(v.Expect.Output)
			if err != nil {
				t.Fatal(err)
			}
			if !equalJSON(output, expected) {
				got, _ := Marshal(output)
				want, _ := Marshal(expected)
				t.Fatalf("got %s, want %s", got, want)
			}
		})
	}
}

// equalJSON compares two values as JSON does: objects by their keys and
// values in any order, lists in order.
func equalJSON(a, b any) bool {
	switch x := a.(type) {
	case *Object:
		y, ok := b.(*Object)
		if !ok || x.Len() != y.Len() {
			return false
		}
		for _, key := range x.Keys() {
			left, _ := x.Get(key)
			right, present := y.Get(key)
			if !present || !equalJSON(left, right) {
				return false
			}
		}
		return true
	case *Array:
		y, ok := b.(*Array)
		if !ok || len(x.Items) != len(y.Items) {
			return false
		}
		for index := range x.Items {
			if !equalJSON(x.Items[index], y.Items[index]) {
				return false
			}
		}
		return true
	default:
		return a == b
	}
}

type envelopeRequest struct {
	Path    string      `json:"path"`
	Search  string      `json:"search"`
	Headers [][2]string `json:"headers"`
	Body    *string     `json:"body,omitempty"`
	Form    bool        `json:"form,omitempty"`
}

type envelopeVector struct {
	Name     string          `json:"name"`
	Template string          `json:"template"`
	Envelope json.RawMessage `json:"envelope"`
	Form     json.RawMessage `json:"form,omitempty"`
	Request  envelopeRequest `json:"request"`
	Expect   struct {
		Request *envelopeRequest `json:"request,omitempty"`
		Refuses string           `json:"refuses,omitempty"`
	} `json:"expect"`
}

// runEnvelopeVector builds the program the TypeScript harness builds: one
// site at the vector's template, whose envelope is the vector's.
func runEnvelopeVector(v envelopeVector) (*envelopeRequest, string) {
	site := map[string]any{"envelope": v.Envelope}
	if len(v.Form) > 0 {
		site["form"] = v.Form
	}
	program, _ := json.Marshal(map[string]any{
		"irVersion":    2,
		"api":          "conformance",
		"current":      "sha256:0",
		"currentLabel": "current",
		"contracts": map[string]any{"old": map[string]any{
			"label":     "old",
			"routes":    []any{},
			"sites":     map[string]any{"post " + v.Template: site},
			"behaviors": []any{},
			"retired":   []any{},
		}},
	})
	runtime, err := Load(program, Options{Identity: oldByDefault})
	if err != nil {
		return nil, "decode"
	}
	out, _, err := runtime.TransformEnvelope("old", "post "+v.Template, EnvelopeRequest{
		Path:    v.Request.Path,
		Search:  v.Request.Search,
		Headers: v.Request.Headers,
		Body:    v.Request.Body,
		Form:    v.Request.Form,
	})
	if err != nil {
		var transform *TransformError
		if errors.As(err, &transform) {
			return nil, transform.ChangeID
		}
		return nil, "error"
	}
	headers := out.Headers
	if headers == nil {
		headers = [][2]string{}
	}
	return &envelopeRequest{Path: out.Path, Search: out.Search, Headers: headers, Body: out.Body}, ""
}

func TestEnvelopeVectors(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "conformance", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Envelopes []envelopeVector `json:"envelopes"`
	}
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Envelopes) == 0 {
		t.Fatal("no envelope vectors")
	}
	for _, v := range file.Envelopes {
		t.Run(v.Name, func(t *testing.T) {
			got, refusedBy := runEnvelopeVector(v)
			if v.Expect.Refuses != "" {
				if refusedBy != v.Expect.Refuses {
					t.Fatalf("expected a refusal by %s, got %q with %+v", v.Expect.Refuses, refusedBy, got)
				}
				return
			}
			if refusedBy != "" {
				t.Fatalf("refused by %s", refusedBy)
			}
			want, _ := json.Marshal(v.Expect.Request)
			have, _ := json.Marshal(got)
			if string(want) != string(have) {
				t.Fatalf("got  %s\nwant %s", have, want)
			}
		})
	}
}

type formVector struct {
	Name   string          `json:"name"`
	Form   json.RawMessage `json:"form"`
	Instrs json.RawMessage `json:"instrs"`
	Input  string          `json:"input"`
	Expect struct {
		Output  *string `json:"output,omitempty"`
		Refuses string  `json:"refuses,omitempty"`
	} `json:"expect"`
}

// runFormVector builds the program the TypeScript harness builds: one site
// with the vector's form declaration and instructions.
func runFormVector(v formVector) (string, string) {
	program, _ := json.Marshal(map[string]any{
		"irVersion":    2,
		"api":          "conformance",
		"current":      "sha256:0",
		"currentLabel": "current",
		"contracts": map[string]any{"old": map[string]any{
			"label":     "old",
			"routes":    []any{},
			"sites":     map[string]any{"post /v": map[string]any{"form": v.Form, "request": v.Instrs}},
			"behaviors": []any{},
			"retired":   []any{},
		}},
	})
	runtime, err := Load(program, Options{Identity: oldByDefault})
	if err != nil {
		return "", "decode"
	}
	out, _, err := runtime.TransformRequestForm("old", "post /v", v.Input)
	if err != nil {
		var transform *TransformError
		if errors.As(err, &transform) {
			return "", transform.ChangeID
		}
		return "", "error"
	}
	return out, ""
}

func TestFormVectors(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "conformance", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Forms []formVector `json:"forms"`
	}
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Forms) == 0 {
		t.Fatal("no form vectors")
	}
	for _, v := range file.Forms {
		t.Run(v.Name, func(t *testing.T) {
			got, refusedBy := runFormVector(v)
			if v.Expect.Refuses != "" {
				if refusedBy != v.Expect.Refuses {
					t.Fatalf("expected a refusal by %s, got %q with %q", v.Expect.Refuses, refusedBy, got)
				}
				return
			}
			if refusedBy != "" {
				t.Fatalf("refused by %s", refusedBy)
			}
			if got != *v.Expect.Output {
				t.Fatalf("got  %s\nwant %s", got, *v.Expect.Output)
			}
		})
	}
}

type xmlVector struct {
	Name   string          `json:"name"`
	XML    json.RawMessage `json:"xml"`
	Instrs json.RawMessage `json:"instrs"`
	Input  string          `json:"input"`
	Expect struct {
		Output  *string `json:"output,omitempty"`
		Refuses string  `json:"refuses,omitempty"`
	} `json:"expect"`
}

// runXMLVector builds the program the TypeScript harness builds: one site
// with the vector's description of its request body and its instructions.
// A refusal is named as the harness names it: decode, body, too-large or the
// change that refused.
func runXMLVector(v xmlVector) (string, string) {
	program, _ := json.Marshal(map[string]any{
		"irVersion":    2,
		"api":          "conformance",
		"current":      "sha256:0",
		"currentLabel": "current",
		"contracts": map[string]any{"old": map[string]any{
			"label":  "old",
			"routes": []any{},
			"sites": map[string]any{"post /v": map[string]any{
				"xml":     map[string]any{"request": v.XML},
				"request": v.Instrs,
			}},
			"behaviors": []any{},
			"retired":   []any{},
		}},
	})
	runtime, err := Load(program, Options{Identity: oldByDefault})
	if err != nil {
		return "", "decode"
	}
	out, _, err := runtime.TransformRequestXML("old", "post /v", v.Input, "application/xml")
	if err != nil {
		var transform *TransformError
		var syntax *SyntaxError
		switch {
		case errors.As(err, &transform):
			return "", transform.ChangeID
		case errors.As(err, &syntax):
			return "", "body"
		case errors.Is(err, ErrTooDeep):
			return "", "too-large"
		}
		return "", "error: " + err.Error()
	}
	return out, ""
}

func TestXMLVectors(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "conformance", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		XML []xmlVector `json:"xml"`
	}
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.XML) == 0 {
		t.Fatal("no XML vectors")
	}
	for _, v := range file.XML {
		t.Run(v.Name, func(t *testing.T) {
			got, refusedBy := runXMLVector(v)
			if v.Expect.Refuses != "" {
				if refusedBy != v.Expect.Refuses {
					t.Fatalf("expected a refusal by %s, got %q with %q", v.Expect.Refuses, refusedBy, got)
				}
				return
			}
			if refusedBy != "" {
				t.Fatalf("refused by %s", refusedBy)
			}
			if got != *v.Expect.Output {
				t.Fatalf("got  %q\nwant %q", got, *v.Expect.Output)
			}
		})
	}
}
