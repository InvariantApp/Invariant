package main

import (
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"testing"
)

// checked type-checks one file of package `sdk` beside a consumer file that
// uses it, the way the loader would, and returns the consumer's syntax and
// types.
func checked(t *testing.T, sdk, consumer string) (*token.FileSet, *ast.File, *types.Info) {
	t.Helper()
	fset := token.NewFileSet()
	sdkFile, err := parser.ParseFile(fset, "sdk.go", sdk, 0)
	if err != nil {
		t.Fatal(err)
	}
	sdkPackage, err := (&types.Config{Importer: importer.Default()}).Check("example.com/sdk", fset, []*ast.File{sdkFile}, nil)
	if err != nil {
		t.Fatal(err)
	}
	file, err := parser.ParseFile(fset, "main.go", consumer, 0)
	if err != nil {
		t.Fatal(err)
	}
	info := &types.Info{
		Types: map[ast.Expr]types.TypeAndValue{},
		Uses:  map[*ast.Ident]types.Object{},
		Defs:  map[*ast.Ident]types.Object{},
	}
	config := &types.Config{Importer: importerFunc(func(path string) (*types.Package, error) {
		if path == "example.com/sdk" {
			return sdkPackage, nil
		}
		return importer.Default().Import(path)
	})}
	if _, err := config.Check("example.com/consumer", fset, []*ast.File{file}, info); err != nil {
		t.Fatal(err)
	}
	return fset, file, info
}

type importerFunc func(path string) (*types.Package, error)

func (f importerFunc) Import(path string) (*types.Package, error) { return f(path) }

const sdkSource = `package sdk

type Status string

type Base struct {
	Email string ` + "`json:\"email\"`" + `
}

type Customer struct {
	Base
	Nickname string ` + "`json:\"nickname\"`" + `
	Status   Status ` + "`json:\"status\"`" + `
}
`

func TestValuesAreFoundByTheirType(t *testing.T) {
	consumer := `package consumer

import (
	"reflect"

	"example.com/sdk"
)

func f(c *sdk.Customer, payload map[string]any, labels map[string]string) []any {
	own := "active"
	return []any{
		c.Status == "active",
		[]sdk.Status{"active", "gone"},
		own == "active",
		&sdk.Customer{Nickname: "Ada", Status: "active"},
		reflect.ValueOf(c).Elem().FieldByName("Email"),
		reflect.ValueOf(c).FieldByName("Nickname"),
		payload["nickname"],
		labels["nickname"],
	}
}
`
	fset, file, info := checked(t, sdkSource, consumer)
	offset := func(pos token.Pos) int { return fset.Position(pos).Offset }
	line := func(pos token.Pos) int { return fset.Position(pos).Line }
	names := &keys{cache: map[*types.Package]map[types.Object]string{}}
	targets := []string{"example.com/sdk"}

	constants, literals := valuesIn(file, info, "main.go", targets, names, offset, line)
	var found []string
	for _, constant := range constants {
		found = append(found, constant.Key+"="+constant.Value)
	}
	// The literal of plain string compared with `own` is not the SDK's.
	want := []string{"Status=active", "Status=active", "Status=gone", "Status=active"}
	if len(found) != len(want) {
		t.Fatalf("constants = %q, want %q", found, want)
	}
	for index := range want {
		if found[index] != want[index] {
			t.Errorf("constant %d = %q, want %q", index, found[index], want[index])
		}
	}
	if len(literals) != 1 || literals[0].Key != "Customer" || len(literals[0].Keys) != 2 {
		t.Errorf("literals = %+v", literals)
	}

	references, keys := namedIn(file, info, "main.go", targets, names, offset, line)
	// `FieldByName` on the pointer itself, without `Elem`, names nothing.
	if len(references) != 1 || references[0].Key != "Base.Email" || references[0].Role != "name" {
		t.Errorf("reflected = %+v", references)
	}
	// Only the map of untyped JSON, not the consumer's own `map[string]string`.
	if len(keys) != 1 || keys[0].Key != "nickname" {
		t.Errorf("keys = %+v", keys)
	}
}
