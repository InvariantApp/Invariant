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
	// Call is what a call passes, where the role is `call`.
	Call *CallShape `json:"call,omitempty"`
	// Value spans the value a field is given, where the role is
	// `literal-key`, or `write` by a plain assignment.
	Value *[2]int `json:"value,omitempty"`
	// NilChecked marks a read from a variable the function reading it
	// compares with nil.
	NilChecked bool `json:"nilChecked,omitempty"`
	// Addressed marks a read whose address is taken, `&customer.Balance`.
	Addressed bool `json:"addressed,omitempty"`
}

// CallShape is where a call's parts are, for rewriting one call into another.
type CallShape struct {
	// Open is the offset of the opening parenthesis.
	Open int       `json:"open"`
	Args []CallArg `json:"args"`
	// TypeArgs spans explicit type arguments, brackets included, where the
	// call has them.
	TypeArgs *[2]int `json:"typeArgs,omitempty"`
}

// CallArg is one argument and, where it is an untyped constant, whose type
// the call's parameter decides, the type it would take on its own.
type CallArg struct {
	Start   int    `json:"start"`
	End     int    `json:"end"`
	Untyped string `json:"untyped,omitempty"`
}

// untypedDefault is the type an untyped constant takes where nothing gives
// it one (`int` for `1`, `string` for `"a"`), or "" where the expression is
// not an untyped constant as written: a literal, an untyped named constant,
// or arithmetic on those. The type checker records such an argument with the
// type its parameter gave it, so the syntax is what says a call chose its
// type.
func untypedDefault(info *types.Info, expression ast.Expr) string {
	// Go's untyped constant kinds, in the order a mixed expression takes the
	// later one.
	order := map[string]int{"int": 1, "rune": 2, "float64": 3, "complex128": 4}
	switch expression := expression.(type) {
	case *ast.BasicLit:
		switch expression.Kind {
		case token.INT:
			return "int"
		case token.FLOAT:
			return "float64"
		case token.IMAG:
			return "complex128"
		case token.CHAR:
			return "rune"
		case token.STRING:
			return "string"
		}
	case *ast.ParenExpr:
		return untypedDefault(info, expression.X)
	case *ast.UnaryExpr:
		if expression.Op == token.NOT {
			return orEmpty(untypedDefault(info, expression.X), "bool")
		}
		return untypedDefault(info, expression.X)
	case *ast.BinaryExpr:
		left, right := untypedDefault(info, expression.X), untypedDefault(info, expression.Y)
		if left == "" || right == "" {
			return ""
		}
		switch expression.Op {
		case token.EQL, token.NEQ, token.LSS, token.LEQ, token.GTR, token.GEQ, token.LAND, token.LOR:
			return "bool"
		case token.SHL, token.SHR:
			return left
		}
		if order[right] > order[left] {
			return right
		}
		return left
	case *ast.Ident:
		constant, ok := info.Uses[expression].(*types.Const)
		if !ok {
			return ""
		}
		basic, ok := constant.Type().(*types.Basic)
		if !ok || basic.Info()&types.IsUntyped == 0 {
			return ""
		}
		name := types.Default(basic).String()
		if name == "int32" {
			return "rune"
		}
		return name
	}
	return ""
}

func orEmpty(value, otherwise string) string {
	if value == "" {
		return ""
	}
	return otherwise
}

func shapeOf(info *types.Info, call *ast.CallExpr, offset func(token.Pos) int) *CallShape {
	shape := &CallShape{Open: offset(call.Lparen), Args: []CallArg{}}
	for _, argument := range call.Args {
		shape.Args = append(shape.Args, CallArg{
			Start:   offset(argument.Pos()),
			End:     offset(argument.End()),
			Untyped: untypedDefault(info, argument),
		})
	}
	fun := call.Fun
	for {
		paren, ok := fun.(*ast.ParenExpr)
		if !ok {
			break
		}
		fun = paren.X
	}
	switch fun := fun.(type) {
	case *ast.IndexExpr:
		shape.TypeArgs = &[2]int{offset(fun.Lbrack), offset(fun.Rbrack) + 1}
	case *ast.IndexListExpr:
		shape.TypeArgs = &[2]int{offset(fun.Lbrack), offset(fun.Rbrack) + 1}
	}
	return shape
}

// Import is one import of an SDK package.
type Import struct {
	File string `json:"file"`
	// Start and End span the quoted path.
	Start int    `json:"start"`
	End   int    `json:"end"`
	Line  int    `json:"line"`
	Path  string `json:"path"`
	// Name is what the file calls the package: the name it is imported as,
	// or the package's own; `.` and `_` as written.
	Name string `json:"name"`
}

// RefsResponse is every reference to the targets in the files loaded.
type RefsResponse struct {
	Files      []string    `json:"files"`
	Imports    []Import    `json:"imports"`
	References []Reference `json:"references"`
	Constants  []Constant  `json:"constants"`
	Literals   []Literal   `json:"literals"`
	// Keys are the string keys read from untyped JSON maps in files that
	// import the SDK.
	Keys []Key `json:"keys"`
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
	fset, loaded, err := loadConsumer(request)
	if err != nil {
		return RefsResponse{}, err
	}
	response := RefsResponse{
		Files:       []string{},
		Imports:     []Import{},
		References:  []Reference{},
		Constants:   []Constant{},
		Literals:    []Literal{},
		Keys:        []Key{},
		Diagnostics: diagnosticsOf(fset, loaded, request.Within),
	}
	response.Errors = loadErrors(loaded)
	names := &keys{cache: map[*types.Package]map[types.Object]string{}}
	for _, entry := range filesOf(loaded, request.Within) {
		file := entry.pkg.Syntax[entry.file]
		response.Files = append(response.Files, entry.path)
		offset := func(pos token.Pos) int { return fset.Position(pos).Offset }
		line := func(pos token.Pos) int { return fset.Position(pos).Line }

		importsTarget := false
		for _, spec := range file.Imports {
			path, err := strconv.Unquote(spec.Path.Value)
			if err != nil || !isTarget(path, request.Targets) {
				continue
			}
			importsTarget = true
			name := ""
			if spec.Name != nil {
				name = spec.Name.Name
			} else if imported, ok := entry.pkg.TypesInfo.Implicits[spec].(*types.PkgName); ok {
				name = imported.Name()
			}
			response.Imports = append(response.Imports, Import{
				File:  entry.path,
				Start: offset(spec.Path.Pos()),
				End:   offset(spec.Path.End()),
				Line:  line(spec.Path.Pos()),
				Path:  path,
				Name:  name,
			})
		}

		info := entry.pkg.TypesInfo
		constants, literals := valuesIn(file, info, entry.path, request.Targets, names, offset, line)
		response.Constants = append(response.Constants, constants...)
		response.Literals = append(response.Literals, literals...)
		reflected, keys := namedIn(file, info, entry.path, request.Targets, names, offset, line)
		response.References = append(response.References, reflected...)
		if importsTarget {
			response.Keys = append(response.Keys, keys...)
		}
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
			if call, ok := span.(*ast.CallExpr); ok && role == "call" {
				reference.Call = shapeOf(info, call, offset)
			}
			if value := valueOf(span, stack); value != nil {
				reference.Value = &[2]int{offset(value.Pos()), offset(value.End())}
			}
			if selector, ok := span.(*ast.SelectorExpr); ok && role == "read" {
				reference.NilChecked = nilChecked(info, selector, stack)
				if len(stack) > 2 {
					unary, isUnary := stack[len(stack)-3].(*ast.UnaryExpr)
					reference.Addressed = isUnary && unary.Op == token.AND && unary.X == selector
				}
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
	// Through parentheses, and through the explicit type arguments a generic
	// function is called with: `github.Ptr[int64](1)`.
	for {
		wrapped := false
		switch wrapper := outer.(type) {
		case *ast.ParenExpr:
			wrapped = true
		case *ast.IndexExpr:
			wrapped = wrapper.X == node
		case *ast.IndexListExpr:
			wrapped = wrapper.X == node
		}
		if !wrapped {
			break
		}
		node = outer
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

// valueOf is the value a field is given at a reference's span: a literal's
// value beside its key, or what a plain assignment writes to it.
func valueOf(span ast.Node, stack []ast.Node) ast.Expr {
	switch span := span.(type) {
	case *ast.KeyValueExpr:
		return span.Value
	case *ast.AssignStmt:
		if span.Tok != token.ASSIGN || len(span.Lhs) != len(span.Rhs) {
			return nil
		}
		for index, target := range span.Lhs {
			for _, node := range stack {
				if node == target {
					return span.Rhs[index]
				}
			}
		}
	}
	return nil
}

func isOneOf(node ast.Node, list []ast.Expr) bool {
	for _, each := range list {
		if each == node {
			return true
		}
	}
	return false
}
