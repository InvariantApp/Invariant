package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"testing"
)

func TestUntypedDefaults(t *testing.T) {
	source := `package a

const big = 1 << 40
const typed int64 = 3

func f(...any) {}

func g() {
	f(1, 2.5, 'x', "s", 1+2.0, big, typed, !true, 1 < 2, int64(4))
}
`
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "a.go", source, 0)
	if err != nil {
		t.Fatal(err)
	}
	info := &types.Info{Types: map[ast.Expr]types.TypeAndValue{}, Uses: map[*ast.Ident]types.Object{}}
	if _, err := (&types.Config{}).Check("a", fset, []*ast.File{file}, info); err != nil {
		t.Fatal(err)
	}
	var call *ast.CallExpr
	ast.Inspect(file, func(node ast.Node) bool {
		if found, ok := node.(*ast.CallExpr); ok && len(found.Args) > 1 {
			call = found
		}
		return true
	})
	// What each argument would be on its own, or "" where it has a type.
	want := []string{"int", "float64", "rune", "string", "float64", "int", "", "bool", "bool", ""}
	for index, argument := range call.Args {
		if got := untypedDefault(info, argument); got != want[index] {
			t.Errorf("argument %d: %q, want %q", index, got, want[index])
		}
	}
}
