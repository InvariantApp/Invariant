package main

import (
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"strings"
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
		Types:      map[ast.Expr]types.TypeAndValue{},
		Uses:       map[*ast.Ident]types.Object{},
		Defs:       map[*ast.Ident]types.Object{},
		Selections: map[*ast.SelectorExpr]*types.Selection{},
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

type Params struct {
	Status Status ` + "`json:\"status\"`" + `
}

func Raw() map[string]any { return nil }
`

func TestValuesAreFoundByTheirType(t *testing.T) {
	consumer := `package consumer

import (
	"reflect"
	"slices"

	"example.com/sdk"
)

func isLive(status sdk.Status) bool {
	return status == "active"
}

func f(c *sdk.Customer, payload map[string]any, labels map[string]string, s sdk.Status) []any {
	own := "active"
	raw := sdk.Raw()
	return []any{
		c.Status == "active",
		slices.Contains([]sdk.Status{"active", "gone"}, c.Status),
		own == "active",
		&sdk.Customer{Nickname: "Ada", Status: "active"},
		&sdk.Params{Status: "active"},
		string(c.Status) == "gone",
		s == "active",
		isLive(c.Status),
		reflect.ValueOf(c).Elem().FieldByName("Email"),
		reflect.ValueOf(c).FieldByName("Nickname"),
		payload["nickname"],
		raw["nickname"],
		labels["nickname"],
	}
}

func g() bool { return f(nil, nil, nil, "gone") != nil }
`
	fset, file, info := checked(t, sdkSource, consumer)
	offset := func(pos token.Pos) int { return fset.Position(pos).Offset }
	line := func(pos token.Pos) int { return fset.Position(pos).Line }
	names := &keys{cache: map[*types.Package]map[types.Object]string{}}
	trace := &tracer{
		fset:    fset,
		targets: []string{"example.com/sdk"},
		names:   names,
		calls:   map[string][]tracedCall{},
		params:  map[string]parameter{},
	}
	trace.index(file, info)

	constants, literals := trace.valuesIn(file, info, "main.go", offset, line)
	var found []string
	for _, constant := range constants {
		fields := []string{}
		for _, field := range constant.Fields {
			fields = append(fields, field.Key)
		}
		entry := constant.Key + "=" + constant.Value + " " + strings.Join(fields, ",")
		if constant.Unknown {
			entry += " ?"
		}
		found = append(found, entry)
	}
	// The literal of plain string compared with `own` is not the SDK's. The
	// one compared with `s` meets whatever `g` passes, a literal, which leads
	// to no field; the one in `isLive` meets what its one caller passes.
	want := []string{
		"Status=active Customer.Status",
		"Status=active Customer.Status",
		"Status=active Customer.Status",
		"Status=gone Customer.Status",
		"Status=active Customer.Status",
		"Status=active Params.Status",
		"Status=gone Customer.Status",
		"Status=active  ?",
		"Status=gone  ?",
	}
	if strings.Join(found, "\n") != strings.Join(want, "\n") {
		t.Fatalf("constants =\n%s\nwant\n%s", strings.Join(found, "\n"), strings.Join(want, "\n"))
	}
	if len(literals) != 2 || literals[0].Key != "Customer" || len(literals[0].Keys) != 2 {
		t.Errorf("literals = %+v", literals)
	}

	references, keys := trace.namedIn(file, info, "main.go", offset, line)
	// `FieldByName` on the pointer itself, without `Elem`, names nothing.
	if len(references) != 1 || references[0].Key != "Base.Email" || references[0].Role != "name" {
		t.Errorf("reflected = %+v", references)
	}
	// Only the untyped JSON the SDK returned: not a parameter nothing ties to
	// the SDK, and not the consumer's own `map[string]string`.
	if len(keys) != 1 || keys[0].Key != "nickname" || keys[0].Line != 29 {
		t.Errorf("keys = %+v", keys)
	}
}
