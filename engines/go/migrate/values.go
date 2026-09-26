package main

import (
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"strconv"
)

// Constant is a string literal the type checker gives one of the SDK's named
// types: `"active"` compared with a `CustomerStatus`, sent as one, or listed
// in a `[]CustomerStatus`. The type is what says the literal is one of the
// SDK's values, wherever it is written, so a value the SDK renamed is found
// through the consumer's own helpers and switches as surely as beside the
// field it came from.
type Constant struct {
	File  string `json:"file"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	Line  int    `json:"line"`
	// Value is the string the literal holds.
	Value string `json:"value"`
	// Package and Key name the type as the SDK's surface does.
	Package string `json:"package"`
	Key     string `json:"key"`
}

// Literal is a composite literal of one of the SDK's struct types: a request
// the consumer builds, or a stand-in for a response.
type Literal struct {
	File  string `json:"file"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	Line  int    `json:"line"`
	// Lbrace and Rbrace are the offsets of its braces.
	Lbrace int `json:"lbrace"`
	Rbrace int `json:"rbrace"`
	// Package and Key name the struct type as the SDK's surface does.
	Package string `json:"package"`
	Key     string `json:"key"`
	// Keys are the fields the literal names, in order.
	Keys []string `json:"keys"`
	// Positional marks a literal that gives its fields by position.
	Positional bool `json:"positional,omitempty"`
	// Elements span each element, in order.
	Elements [][2]int `json:"elements"`
}

// sdkNamed is the named type a type is, through a pointer, where one of the
// targets declares it.
func sdkNamed(typ types.Type, targets []string) *types.Named {
	if typ == nil {
		return nil
	}
	if pointer, ok := types.Unalias(typ).(*types.Pointer); ok {
		typ = pointer.Elem()
	}
	named, ok := types.Unalias(typ).(*types.Named)
	if !ok || named.Obj().Pkg() == nil || !isTarget(named.Obj().Pkg().Path(), targets) {
		return nil
	}
	return named
}

// valuesIn finds the SDK-typed string literals and the SDK struct literals
// in one file.
func valuesIn(
	file *ast.File,
	info *types.Info,
	path string,
	targets []string,
	names *keys,
	offset func(token.Pos) int,
	line func(token.Pos) int,
) ([]Constant, []Literal) {
	constants := []Constant{}
	literals := []Literal{}
	ast.Inspect(file, func(node ast.Node) bool {
		switch node := node.(type) {
		case *ast.ImportSpec, *ast.Field:
			// An import path and a struct tag are strings of no type.
			return false
		case *ast.BasicLit:
			if node.Kind != token.STRING {
				return true
			}
			typed, ok := info.Types[node]
			if !ok || typed.Value == nil || typed.Value.Kind() != constant.String {
				return true
			}
			// Only the type itself, not a pointer to one: a literal is never that.
			named, ok := types.Unalias(typed.Type).(*types.Named)
			if !ok || sdkNamed(named, targets) == nil {
				return true
			}
			object := named.Obj()
			constants = append(constants, Constant{
				File:    path,
				Start:   offset(node.Pos()),
				End:     offset(node.End()),
				Line:    line(node.Pos()),
				Value:   constant.StringVal(typed.Value),
				Package: relativePackage(object.Pkg().Path(), moduleOf(object.Pkg().Path(), targets)),
				Key:     names.of(object),
			})
		case *ast.CompositeLit:
			named := sdkNamed(info.TypeOf(node), targets)
			if named == nil {
				return true
			}
			if _, isStruct := named.Underlying().(*types.Struct); !isStruct {
				return true
			}
			object := named.Obj()
			literal := Literal{
				File:     path,
				Start:    offset(node.Pos()),
				End:      offset(node.End()),
				Line:     line(node.Pos()),
				Lbrace:   offset(node.Lbrace),
				Rbrace:   offset(node.Rbrace),
				Package:  relativePackage(object.Pkg().Path(), moduleOf(object.Pkg().Path(), targets)),
				Key:      names.of(object),
				Keys:     []string{},
				Elements: [][2]int{},
			}
			for _, element := range node.Elts {
				literal.Elements = append(literal.Elements, [2]int{offset(element.Pos()), offset(element.End())})
				pair, keyed := element.(*ast.KeyValueExpr)
				if !keyed {
					literal.Positional = true
					continue
				}
				if key, ok := pair.Key.(*ast.Ident); ok {
					literal.Keys = append(literal.Keys, key.Name)
				}
			}
			literals = append(literals, literal)
		}
		return true
	})
	return constants, literals
}

// nilChecked says whether the variable a field is read from is compared with
// nil in the function that reads it: `if customer == nil { return 0 }`. The
// code has decided there what the absent case means, in the value's old
// terms, so converting the read is a decision about that case too.
func nilChecked(info *types.Info, selector *ast.SelectorExpr, stack []ast.Node) bool {
	receiver, ok := ast.Unparen(selector.X).(*ast.Ident)
	if !ok {
		return false
	}
	variable, ok := info.Uses[receiver].(*types.Var)
	if !ok || variable.IsField() {
		return false
	}
	var body ast.Node
	for index := len(stack) - 1; index >= 0 && body == nil; index-- {
		switch fn := stack[index].(type) {
		case *ast.FuncDecl:
			body = fn.Body
		case *ast.FuncLit:
			body = fn.Body
		}
	}
	if body == nil {
		return false
	}
	isNil := func(expression ast.Expr) bool {
		ident, ok := ast.Unparen(expression).(*ast.Ident)
		if !ok {
			return false
		}
		_, isNil := info.Uses[ident].(*types.Nil)
		return isNil
	}
	isVariable := func(expression ast.Expr) bool {
		ident, ok := ast.Unparen(expression).(*ast.Ident)
		return ok && info.Uses[ident] == variable
	}
	found := false
	ast.Inspect(body, func(node ast.Node) bool {
		comparison, ok := node.(*ast.BinaryExpr)
		if !ok || found || (comparison.Op != token.EQL && comparison.Op != token.NEQ) {
			return !found
		}
		if (isVariable(comparison.X) && isNil(comparison.Y)) ||
			(isNil(comparison.X) && isVariable(comparison.Y)) {
			found = true
		}
		return !found
	})
	return found
}

// Key is a string key read from a map of untyped JSON, `object["nickname"]`
// where `object` is a `map[string]any`: the way a webhook handler reads a
// payload it never decodes into the SDK's types. Nothing types it, so it is
// only ever shown, and only in a file that uses the SDK.
type Key struct {
	File  string `json:"file"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	Line  int    `json:"line"`
	// Key is the string the map is indexed by.
	Key string `json:"key"`
	// SpanStart and SpanEnd are the index expression's.
	SpanStart int `json:"spanStart"`
	SpanEnd   int `json:"spanEnd"`
}

// namedIn finds, in one file, the fields named in strings through reflection
// on a value whose type is one of the SDK's structs, as references with the
// role `name`, and the keys read from untyped JSON maps.
func namedIn(
	file *ast.File,
	info *types.Info,
	path string,
	targets []string,
	names *keys,
	offset func(token.Pos) int,
	line func(token.Pos) int,
) ([]Reference, []Key) {
	references := []Reference{}
	found := []Key{}
	ast.Inspect(file, func(node ast.Node) bool {
		switch node := node.(type) {
		case *ast.IndexExpr:
			key, ok := node.Index.(*ast.BasicLit)
			if !ok || key.Kind != token.STRING || !untypedJSON(info.TypeOf(node.X)) {
				return true
			}
			value, err := strconv.Unquote(key.Value)
			if err != nil {
				return true
			}
			found = append(found, Key{
				File:      path,
				Start:     offset(key.Pos()),
				End:       offset(key.End()),
				Line:      line(key.Pos()),
				Key:       value,
				SpanStart: offset(node.Pos()),
				SpanEnd:   offset(node.End()),
			})
		case *ast.CallExpr:
			field, literal := reflectedField(info, node, targets)
			if field == nil {
				return true
			}
			references = append(references, Reference{
				File:      path,
				Start:     offset(literal.Pos()),
				End:       offset(literal.End()),
				Line:      line(literal.Pos()),
				Package:   relativePackage(field.Pkg().Path(), moduleOf(field.Pkg().Path(), targets)),
				Key:       names.of(field),
				Kind:      "field",
				Role:      "name",
				SpanStart: offset(node.Pos()),
				SpanEnd:   offset(node.End()),
				JSON:      fieldTag(field, names),
			})
		}
		return true
	})
	return references, found
}

// untypedJSON says whether a type is a map from strings to anything, which
// is what `json.Unmarshal` fills when nothing says what the JSON is.
func untypedJSON(typ types.Type) bool {
	if typ == nil {
		return false
	}
	mapping, ok := types.Unalias(typ).Underlying().(*types.Map)
	if !ok {
		return false
	}
	key, ok := mapping.Key().Underlying().(*types.Basic)
	if !ok || key.Kind() != types.String {
		return false
	}
	value, ok := types.Unalias(mapping.Elem()).Underlying().(*types.Interface)
	return ok && value.Empty()
}

// reflectedField is the field `FieldByName("Nickname")` reads, where the
// value it is called on is `reflect.ValueOf(x)` or `reflect.TypeOf(x)`, as
// many `.Elem()` as x has pointers, and x's type is one of the SDK's structs.
// A value of a concrete type holds exactly that type, so the string names
// the struct's field as surely as a selector would.
func reflectedField(info *types.Info, call *ast.CallExpr, targets []string) (*types.Var, *ast.BasicLit) {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != "FieldByName" || len(call.Args) != 1 {
		return nil, nil
	}
	literal, ok := call.Args[0].(*ast.BasicLit)
	if !ok || literal.Kind != token.STRING {
		return nil, nil
	}
	name, err := strconv.Unquote(literal.Value)
	if err != nil {
		return nil, nil
	}
	receiver := ast.Unparen(selector.X)
	elems := 0
	for {
		step, ok := receiver.(*ast.CallExpr)
		if !ok {
			return nil, nil
		}
		method, ok := step.Fun.(*ast.SelectorExpr)
		if !ok {
			return nil, nil
		}
		if method.Sel.Name == "Elem" && len(step.Args) == 0 && isReflect(info.TypeOf(method.X)) {
			elems++
			receiver = ast.Unparen(method.X)
			continue
		}
		function, ok := info.Uses[method.Sel].(*types.Func)
		if !ok || function.Pkg() == nil || function.Pkg().Path() != "reflect" ||
			(function.Name() != "ValueOf" && function.Name() != "TypeOf") || len(step.Args) != 1 {
			return nil, nil
		}
		typ := info.TypeOf(step.Args[0])
		if typ == nil {
			return nil, nil
		}
		if _, isInterface := typ.Underlying().(*types.Interface); isInterface {
			return nil, nil
		}
		for ; elems > 0; elems-- {
			pointer, ok := types.Unalias(typ).(*types.Pointer)
			if !ok {
				return nil, nil
			}
			typ = pointer.Elem()
		}
		named, ok := types.Unalias(typ).(*types.Named)
		if !ok || sdkNamed(named, targets) == nil {
			return nil, nil
		}
		if _, isStruct := named.Underlying().(*types.Struct); !isStruct {
			return nil, nil
		}
		object, _, _ := types.LookupFieldOrMethod(named, false, named.Obj().Pkg(), name)
		field, ok := object.(*types.Var)
		if !ok || !field.IsField() {
			return nil, nil
		}
		return field, literal
	}
}

// isReflect says whether a type is reflect's Value or Type.
func isReflect(typ types.Type) bool {
	named, ok := types.Unalias(typ).(*types.Named)
	if !ok || named.Obj().Pkg() == nil || named.Obj().Pkg().Path() != "reflect" {
		return false
	}
	return named.Obj().Name() == "Value" || named.Obj().Name() == "Type"
}
