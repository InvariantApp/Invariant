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
	runtime, err := Load(programFor(v), Options{Limits: Limits{MaxMatches: v.MaxMatches}})
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
