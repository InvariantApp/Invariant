package main

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

func TestWireName(t *testing.T) {
	cases := map[string]string{
		`json:"amount"`:           "amount",
		`json:"key_id,omitempty"`: "key_id",
		`json:",omitempty"`:       "Amount",
		`json:"-"`:                "-",
		`url:"per_page"`:          "Amount",
		``:                        "Amount",
	}
	for tag, want := range cases {
		if got := wireName(tag, "Amount"); got != want {
			t.Errorf("wireName(%q) = %q, want %q", tag, got, want)
		}
	}
}

func TestOperationsAreReadFromDirectives(t *testing.T) {
	source := `package github

// DeleteEnvSecret deletes a secret in an environment.
//
// GitHub API docs: https://docs.github.com/rest/actions/secrets
//
//meta:operation DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}
func (s *ActionsService) DeleteEnvSecret() {}

// Old is not to be used.
//
// Deprecated: use New.
func Old() {}
`
	file, err := parser.ParseFile(token.NewFileSet(), "a.go", source, parser.ParseComments)
	if err != nil {
		t.Fatal(err)
	}
	docs := docsOf([]*ast.File{file})
	operations := operationsIn(docs["ActionsService.DeleteEnvSecret"])
	if len(operations) != 1 || operations[0] != "DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}" {
		t.Errorf("operations = %q", operations)
	}
	if !strings.Contains(docs["Old"], "\nDeprecated:") {
		t.Errorf("the deprecation paragraph was not kept: %q", docs["Old"])
	}
}

func TestTargetsAreWholePathSegments(t *testing.T) {
	targets := []string{"github.com/google/go-github/v88"}
	for path, want := range map[string]bool{
		"github.com/google/go-github/v88":        true,
		"github.com/google/go-github/v88/github": true,
		"github.com/google/go-github/v880":       false,
		"github.com/google/go-github/v89/github": false,
	} {
		if got := isTarget(path, targets); got != want {
			t.Errorf("isTarget(%q) = %v", path, got)
		}
	}
	if !isWithin("/repo/a/b.go", "/repo") || isWithin("/repository/b.go", "/repo") {
		t.Error("isWithin must compare whole directories")
	}
}

func TestFormatRequest(t *testing.T) {
	request := `{"command":"format","files":[{"path":"a.go","text":"package a\nvar x = struct{A int; LongerName int}{A: 1, LongerName: 2}\n"},{"path":"b.go","text":"package"}]}`
	var out bytes.Buffer
	if err := run(strings.NewReader(request), &out); err != nil {
		t.Fatal(err)
	}
	var files []FormatFile
	if err := json.Unmarshal(out.Bytes(), &files); err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || !strings.Contains(files[0].Text, "struct {") || files[0].Error != "" {
		t.Errorf("a.go was not formatted: %+v", files[0])
	}
	if files[1].Error == "" || files[1].Text != "package" {
		t.Errorf("b.go should come back as it was, with the reason: %+v", files[1])
	}
}

func TestStatementOfStopsAtTheInitOfAnIf(t *testing.T) {
	source := `package a

func f() error {
	if _, err := call(1, 2); err != nil {
		return err
	}
	return nil
}

func call(a, b int) (int, error) { return a + b, nil }
`
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "a.go", source, 0)
	if err != nil {
		t.Fatal(err)
	}
	at := token.Pos(fset.File(file.Pos()).Base() + strings.Index(source, "2);"))
	path := pathTo(file, at)
	statement := statementOf(path)
	if _, ok := statement.(*ast.AssignStmt); !ok {
		t.Fatalf("statementOf = %T, want the if's init", statement)
	}
	if call := callIn(path); call == nil || len(call.Args) != 2 {
		t.Fatalf("callIn = %v", call)
	}
}

// pathTo is the nodes enclosing a position, innermost first.
func pathTo(file *ast.File, pos token.Pos) []ast.Node {
	var path []ast.Node
	ast.Inspect(file, func(node ast.Node) bool {
		if node == nil || pos < node.Pos() || pos >= node.End() {
			return false
		}
		path = append([]ast.Node{node}, path...)
		return true
	})
	return path
}
