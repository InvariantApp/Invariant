package main

import (
	"go/ast"
	"go/token"
	"go/types"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/tools/go/ast/inspector"
)

// Reference is one place the consumer names something the SDK declares.
type Reference struct {
	File string `json:"file"`
	// Start and End are the identifier's byte offsets in the file.
	Start int `json:"start"`
	End   int `json:"end"`
	Line  int `json:"line"`
	// Package and Key name the object as the SDK's surface does.
	Package string `json:"package"`
	Key     string `json:"key"`
	Kind    string `json:"kind"`
	// Role is what the consumer does with it there: `call`, `method-value`,
	// `read`, `write`, `literal-key`, `type` or `value`.
	Role string `json:"role"`
	// SpanStart and SpanEnd are the byte offsets of the expression the role
	// is about: the whole call, the selector read, the assignment written, the
	// key and value in a literal.
	SpanStart int `json:"spanStart"`
	SpanEnd   int `json:"spanEnd"`
	// JSON is a field's wire name.
	JSON string `json:"json,omitempty"`
}

// Import is one import of an SDK package.
type Import struct {
	File string `json:"file"`
	// Start and End span the quoted path.
	Start int    `json:"start"`
	End   int    `json:"end"`
	Line  int    `json:"line"`
	Path  string `json:"path"`
}

// RefsResponse is every reference to the targets in the files loaded.
type RefsResponse struct {
	Files      []string    `json:"files"`
	Imports    []Import    `json:"imports"`
	References []Reference `json:"references"`
	// Diagnostics are what did not compile as the code stands, so a later
	// check can tell what the migration broke from what was already broken.
	Diagnostics []Diagnostic `json:"diagnostics"`
	Errors      []string     `json:"errors,omitempty"`
}

// keys names the objects a package declares the way its surface does, so a
// field reached through an alias, a promoted embedding or a composite
// literal's key is still named by the type that declares it.
type keys struct {
	cache map[*types.Package]map[types.Object]string
}

func (k *keys) of(object types.Object) string {
	pkg := object.Pkg()
	if pkg == nil {
		return object.Name()
	}
	table, ok := k.cache[pkg]
	if !ok {
		table = map[types.Object]string{}
		scope := pkg.Scope()
		for _, name := range scope.Names() {
			declared := scope.Lookup(name)
			table[declared] = name
			typeName, isType := declared.(*types.TypeName)
			if !isType {
				continue
			}
			if structure, ok := typeName.Type().Underlying().(*types.Struct); ok {
				indexFields(table, name, structure)
			}
			if iface, ok := typeName.Type().Underlying().(*types.Interface); ok {
				for index := 0; index < iface.NumExplicitMethods(); index++ {
					method := iface.ExplicitMethod(index)
					table[method] = name + "." + method.Name()
				}
			}
			if named, ok := typeName.Type().(*types.Named); ok {
				for index := 0; index < named.NumMethods(); index++ {
					method := named.Method(index)
					table[method] = name + "." + method.Name()
				}
			}
		}
		k.cache[pkg] = table
	}
	if key, ok := table[object]; ok {
		return key
	}
	// A method or field of an instantiated generic type is its origin's.
	switch object := object.(type) {
	case *types.Func:
		if origin := object.Origin(); origin != object {
			return k.of(origin)
		}
	case *types.Var:
		if origin := object.Origin(); origin != object {
			return k.of(origin)
		}
	}
	return object.Name()
}

func indexFields(table map[types.Object]string, prefix string, structure *types.Struct) {
	for index := 0; index < structure.NumFields(); index++ {
		field := structure.Field(index)
		key := prefix + "." + field.Name()
		table[field] = key
		if inline, ok := field.Type().(*types.Struct); ok {
			indexFields(table, key, inline)
		}
	}
}

func kindOf(object types.Object) string {
	switch object := object.(type) {
	case *types.TypeName:
		return "type"
	case *types.Func:
		if object.Type().(*types.Signature).Recv() != nil {
			return "method"
		}
		return "func"
	case *types.Var:
		if object.IsField() {
			return "field"
		}
		return "var"
	case *types.Const:
		return "const"
	case *types.PkgName:
		return "package"
	}
	return "other"
}

// references finds every use of the targets' objects in the loaded files.
func references(request Request) (RefsResponse, error) {
	fset, loaded, err := load(request)
	if err != nil {
		return RefsResponse{}, err
	}
	response := RefsResponse{
		Files:       []string{},
		Imports:     []Import{},
		References:  []Reference{},
		Diagnostics: diagnosticsOf(fset, loaded, request.Within),
	}
	response.Errors = loadErrors(loaded)
	names := &keys{cache: map[*types.Package]map[types.Object]string{}}
	for _, entry := range filesOf(loaded, request.Within) {
		file := entry.pkg.Syntax[entry.file]
		response.Files = append(response.Files, entry.path)
		offset := func(pos token.Pos) int { return fset.Position(pos).Offset }
		line := func(pos token.Pos) int { return fset.Position(pos).Line }

		for _, spec := range file.Imports {
			path, err := strconv.Unquote(spec.Path.Value)
			if err != nil || !isTarget(path, request.Targets) {
				continue
			}
			response.Imports = append(response.Imports, Import{
				File:  entry.path,
				Start: offset(spec.Path.Pos()),
				End:   offset(spec.Path.End()),
				Line:  line(spec.Path.Pos()),
				Path:  path,
			})
		}

		info := entry.pkg.TypesInfo
		inspect := inspector.New([]*ast.File{file})
		inspect.WithStack([]ast.Node{(*ast.Ident)(nil)}, func(node ast.Node, push bool, stack []ast.Node) bool {
			if !push {
				return true
			}
			ident := node.(*ast.Ident)
			object := info.Uses[ident]
			if object == nil || object.Pkg() == nil || !isTarget(object.Pkg().Path(), request.Targets) {
				return true
			}
			if _, isPackage := object.(*types.PkgName); isPackage {
				return true
			}
			role, span := roleOf(ident, object, stack)
			reference := Reference{
				File:      entry.path,
				Start:     offset(ident.Pos()),
				End:       offset(ident.End()),
				Line:      line(ident.Pos()),
				Package:   relativePackage(object.Pkg().Path(), moduleOf(object.Pkg().Path(), request.Targets)),
				Key:       names.of(object),
				Kind:      kindOf(object),
				Role:      role,
				SpanStart: offset(span.Pos()),
				SpanEnd:   offset(span.End()),
			}
			if field, ok := object.(*types.Var); ok && field.IsField() {
				reference.JSON = fieldTag(field, names)
			}
			response.References = append(response.References, reference)
			return true
		})
	}
	sort.SliceStable(response.References, func(i, j int) bool {
		a, b := response.References[i], response.References[j]
		if a.File != b.File {
			return a.File < b.File
		}
		return a.Start < b.Start
	})
	return response, nil
}

func moduleOf(path string, targets []string) string {
	for _, target := range targets {
		if path == target || strings.HasPrefix(path, target+"/") {
			return target
		}
	}
	return path
}

// fieldTag is a field's wire name, read from the struct that declares it.
func fieldTag(field *types.Var, names *keys) string {
	key := names.of(field)
	holder, _, found := strings.Cut(key, ".")
	if !found || field.Pkg() == nil {
		return ""
	}
	typeName, ok := field.Pkg().Scope().Lookup(holder).(*types.TypeName)
	if !ok {
		return ""
	}
	structure, ok := typeName.Type().Underlying().(*types.Struct)
	if !ok {
		return ""
	}
	return tagIn(structure, field)
}

func tagIn(structure *types.Struct, field *types.Var) string {
	for index := 0; index < structure.NumFields(); index++ {
		candidate := structure.Field(index)
		if candidate == field {
			return wireName(structure.Tag(index), field.Name())
		}
		if inline, ok := candidate.Type().(*types.Struct); ok {
			if tag := tagIn(inline, field); tag != "" {
				return tag
			}
		}
	}
	return ""
}

// roleOf says what the consumer does with an identifier, and the expression
// that says so, from the syntax around it.
func roleOf(ident *ast.Ident, object types.Object, stack []ast.Node) (string, ast.Node) {
	parent := func(depth int) ast.Node {
		if len(stack) > depth {
			return stack[len(stack)-1-depth]
		}
		return nil
	}
	node := ast.Node(ident)
	at := 1
	if selector, ok := parent(1).(*ast.SelectorExpr); ok && selector.Sel == ident {
		node = selector
		at = 2
	}
	outer := parent(at)
	for {
		paren, ok := outer.(*ast.ParenExpr)
		if !ok {
			break
		}
		node = paren
		at++
		outer = parent(at)
	}
	if call, ok := outer.(*ast.CallExpr); ok && call.Fun == node {
		if _, isType := object.(*types.TypeName); isType {
			return "type", call
		}
		return "call", call
	}
	if pair, ok := outer.(*ast.KeyValueExpr); ok && pair.Key == ident {
		return "literal-key", pair
	}
	switch object := object.(type) {
	case *types.TypeName:
		return "type", node
	case *types.Func:
		if object.Type().(*types.Signature).Recv() != nil {
			return "method-value", node
		}
		return "value", node
	case *types.Var:
		if !object.IsField() {
			if assign, ok := outer.(*ast.AssignStmt); ok && isOneOf(node, assign.Lhs) {
				return "write", assign
			}
			return "value", node
		}
		if assign, ok := outer.(*ast.AssignStmt); ok && isOneOf(node, assign.Lhs) {
			return "write", assign
		}
		if step, ok := outer.(*ast.IncDecStmt); ok && step.X == node {
			return "write", step
		}
		return "read", node
	}
	return "value", node
}

func isOneOf(node ast.Node, list []ast.Expr) bool {
	for _, each := range list {
		if each == node {
			return true
		}
	}
	return false
}
