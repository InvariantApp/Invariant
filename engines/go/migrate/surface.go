package main

import (
	"fmt"
	"go/ast"
	"go/types"
	"reflect"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

// SurfaceObject is one exported thing an SDK offers: a type, a field of one,
// a method, a function, a variable or a constant.
type SurfaceObject struct {
	// Package is the import path inside the SDK's module, "" for its root, so
	// two major versions, whose module paths differ, name it the same way.
	Package string `json:"package"`
	// Key is the object's name, qualified by what holds it: `Repository`,
	// `Repository.Name`, `ActionsService.DeleteEnvSecret`.
	Key  string `json:"key"`
	Kind string `json:"kind"`
	// Type is a field's, variable's or constant's type, a type's underlying
	// type, or a function's signature without parameter names, printed so two
	// releases print the same type the same way.
	Type string `json:"type"`
	// Signature is a function's signature with its parameter names, for
	// saying what changed in words a person reads.
	Signature string `json:"signature,omitempty"`
	// JSON is the wire name a field's `json` tag gives it; "-" is never sent.
	JSON string `json:"json,omitempty"`
	// Embedded marks a field that promotes another type's fields.
	Embedded bool `json:"embedded,omitempty"`
	// Operations are the API operations a method's documentation says it
	// calls, as go-github writes them: `//meta:operation GET /repos/{owner}/{repo}`.
	Operations []string `json:"operations,omitempty"`
	// Params are a function's parameter types in order, printed as Type is.
	Params []string `json:"params,omitempty"`
	// Deprecated marks what the SDK's documentation says not to use.
	Deprecated bool `json:"deprecated,omitempty"`
}

// SurfaceResponse is an SDK's exported surface, sorted.
type SurfaceResponse struct {
	Objects []SurfaceObject `json:"objects"`
	Errors  []string        `json:"errors,omitempty"`
}

// surface reads what an SDK's packages export. Its module is Targets[0].
func surface(request Request) (SurfaceResponse, error) {
	if len(request.Targets) != 1 {
		return SurfaceResponse{}, fmt.Errorf("surface needs the SDK's module path as its one target")
	}
	module := request.Targets[0]
	request.Tests = false
	_, loaded, err := load(request)
	if err != nil {
		return SurfaceResponse{}, err
	}
	response := SurfaceResponse{Objects: []SurfaceObject{}, Errors: loadErrors(loaded)}
	for _, pkg := range loaded {
		if pkg.Types == nil || !isTarget(pkg.PkgPath, []string{module}) {
			continue
		}
		response.Objects = append(response.Objects, surfaceOf(pkg, module)...)
	}
	sort.Slice(response.Objects, func(i, j int) bool {
		a, b := response.Objects[i], response.Objects[j]
		if a.Package != b.Package {
			return a.Package < b.Package
		}
		return a.Key < b.Key
	})
	return response, nil
}

// withinModule prints the SDK's own packages by their path inside the
// module, so `v88/github.Response` and `v89/github.Response` read the same.
func withinModule(pkg *types.Package, module string) types.Qualifier {
	return func(other *types.Package) string {
		if other == pkg {
			return ""
		}
		if isTarget(other.Path(), []string{module}) {
			return "~" + strings.TrimPrefix(other.Path(), module)
		}
		return other.Path()
	}
}

func relativePackage(path, module string) string {
	return strings.TrimPrefix(strings.TrimPrefix(path, module), "/")
}

func surfaceOf(pkg *packages.Package, module string) []SurfaceObject {
	qualifier := withinModule(pkg.Types, module)
	relative := relativePackage(pkg.PkgPath, module)
	docs := docsOf(pkg.Syntax)
	var objects []SurfaceObject
	add := func(object SurfaceObject) {
		object.Package = relative
		doc := docs[object.Key]
		object.Operations = operationsIn(doc)
		object.Deprecated = strings.Contains(doc, "\nDeprecated:") || strings.HasPrefix(doc, "Deprecated:")
		objects = append(objects, object)
	}
	scope := pkg.Types.Scope()
	for _, name := range scope.Names() {
		object := scope.Lookup(name)
		if !object.Exported() {
			continue
		}
		switch object := object.(type) {
		case *types.TypeName:
			add(SurfaceObject{Key: name, Kind: "type", Type: types.TypeString(object.Type().Underlying(), qualifier)})
			if structure, ok := object.Type().Underlying().(*types.Struct); ok {
				for _, field := range fieldsOf(name, structure, qualifier) {
					add(field)
				}
			}
			if iface, ok := object.Type().Underlying().(*types.Interface); ok {
				for index := 0; index < iface.NumExplicitMethods(); index++ {
					method := iface.ExplicitMethod(index)
					if method.Exported() {
						add(methodObject(name, method, qualifier))
					}
				}
			}
			if named, ok := object.Type().(*types.Named); ok {
				for index := 0; index < named.NumMethods(); index++ {
					method := named.Method(index)
					if method.Exported() {
						add(methodObject(name, method, qualifier))
					}
				}
			}
		case *types.Func:
			add(SurfaceObject{
				Key:       name,
				Kind:      "func",
				Type:      unnamedSignature(object.Type().(*types.Signature), qualifier),
				Signature: types.TypeString(object.Type(), qualifier),
				Params:    paramTypes(object.Type().(*types.Signature), qualifier),
			})
		case *types.Var:
			add(SurfaceObject{Key: name, Kind: "var", Type: types.TypeString(object.Type(), qualifier)})
		case *types.Const:
			add(SurfaceObject{Key: name, Kind: "const", Type: types.TypeString(object.Type(), qualifier)})
		}
	}
	return objects
}

func methodObject(holder string, method *types.Func, qualifier types.Qualifier) SurfaceObject {
	signature := method.Type().(*types.Signature)
	return SurfaceObject{
		Key:       holder + "." + method.Name(),
		Kind:      "method",
		Type:      unnamedSignature(signature, qualifier),
		Signature: types.TypeString(types.NewSignatureType(nil, nil, nil, signature.Params(), signature.Results(), signature.Variadic()), qualifier),
		Params:    paramTypes(signature, qualifier),
	}
}

func paramTypes(signature *types.Signature, qualifier types.Qualifier) []string {
	params := make([]string, signature.Params().Len())
	for index := range params {
		params[index] = types.TypeString(signature.Params().At(index).Type(), qualifier)
	}
	return params
}

// fieldsOf lists a struct's exported fields, and the fields of any struct
// written inline in it, qualified by the path to them.
func fieldsOf(prefix string, structure *types.Struct, qualifier types.Qualifier) []SurfaceObject {
	var fields []SurfaceObject
	for index := 0; index < structure.NumFields(); index++ {
		field := structure.Field(index)
		if !field.Exported() {
			continue
		}
		key := prefix + "." + field.Name()
		fields = append(fields, SurfaceObject{
			Key:      key,
			Kind:     "field",
			Type:     types.TypeString(field.Type(), qualifier),
			JSON:     wireName(structure.Tag(index), field.Name()),
			Embedded: field.Embedded(),
		})
		if inline, ok := field.Type().(*types.Struct); ok {
			fields = append(fields, fieldsOf(key, inline, qualifier)...)
		}
	}
	return fields
}

// wireName is the name encoding/json gives a field: its tag's name, or the
// field's own name where the tag gives none.
func wireName(tag, field string) string {
	value, ok := reflect.StructTag(tag).Lookup("json")
	if !ok {
		return field
	}
	name, _, _ := strings.Cut(value, ",")
	if name == "" {
		return field
	}
	return name
}

// unnamedSignature prints a signature without its parameter names, which a
// release may change without changing anything a caller writes.
func unnamedSignature(signature *types.Signature, qualifier types.Qualifier) string {
	strip := func(tuple *types.Tuple) *types.Tuple {
		vars := make([]*types.Var, tuple.Len())
		for index := range vars {
			vars[index] = types.NewParam(tuple.At(index).Pos(), nil, "", tuple.At(index).Type())
		}
		return types.NewTuple(vars...)
	}
	return types.TypeString(types.NewSignatureType(nil, nil, nil, strip(signature.Params()), strip(signature.Results()), signature.Variadic()), qualifier)
}

// docsOf is each declaration's documentation by the key its object has.
func docsOf(files []*ast.File) map[string]string {
	docs := map[string]string{}
	for _, file := range files {
		for _, declaration := range file.Decls {
			switch declaration := declaration.(type) {
			case *ast.FuncDecl:
				if declaration.Doc == nil {
					continue
				}
				key := declaration.Name.Name
				if declaration.Recv != nil && len(declaration.Recv.List) == 1 {
					key = receiverName(declaration.Recv.List[0].Type) + "." + key
				}
				docs[key] = rawDoc(declaration.Doc)
			case *ast.GenDecl:
				for _, spec := range declaration.Specs {
					doc := declaration.Doc
					switch spec := spec.(type) {
					case *ast.TypeSpec:
						if spec.Doc != nil {
							doc = spec.Doc
						}
						if doc != nil {
							docs[spec.Name.Name] = rawDoc(doc)
						}
					case *ast.ValueSpec:
						if spec.Doc != nil {
							doc = spec.Doc
						}
						for _, name := range spec.Names {
							if doc != nil {
								docs[name.Name] = rawDoc(doc)
							}
						}
					}
				}
			}
		}
	}
	return docs
}

// rawDoc keeps directive lines, which `CommentGroup.Text` drops, because
// `//meta:operation` is one.
func rawDoc(group *ast.CommentGroup) string {
	lines := make([]string, 0, len(group.List))
	for _, comment := range group.List {
		text := strings.TrimPrefix(comment.Text, "//")
		lines = append(lines, strings.TrimPrefix(text, " "))
	}
	return strings.Join(lines, "\n")
}

func operationsIn(doc string) []string {
	var operations []string
	for _, line := range strings.Split(doc, "\n") {
		if operation, ok := strings.CutPrefix(line, "meta:operation "); ok {
			operations = append(operations, strings.TrimSpace(operation))
		}
	}
	return operations
}

func receiverName(expression ast.Expr) string {
	switch expression := expression.(type) {
	case *ast.StarExpr:
		return receiverName(expression.X)
	case *ast.IndexExpr:
		return receiverName(expression.X)
	case *ast.IndexListExpr:
		return receiverName(expression.X)
	case *ast.Ident:
		return expression.Name
	}
	return ""
}
