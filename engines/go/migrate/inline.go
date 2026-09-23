package main

import (
	"go/ast"
	"go/types"
	"strings"

	"golang.org/x/tools/go/packages"
)

// Inline is what a call to a function marked `//go:fix inline` becomes: the
// SDK's own authors saying the function is only a name for something else,
// which the Go toolchain's inliner rewrites calls into.
//
// go-github 84 marked `String(v string) *string { return Ptr(v) }` so, and
// go-github 92 marked `Ptr[T any](v T) *T { return new(v) }`. Only those two
// shapes of body are read: a call to another function of the same package
// with the parameters in order, and the builtin `new` of the one parameter.
// Anything else is left to the check after the edits.
type Inline struct {
	// To is the function of the same package the body calls.
	To string `json:"to,omitempty"`
	// TypeArgs are the type arguments the body instantiates To with, which a
	// call site needs spelled out where an untyped constant would infer
	// another type: `Int64(1)` is `Ptr[int64](1)`, not `Ptr(1)`.
	TypeArgs []string `json:"typeArgs,omitempty"`
	// Builtin is "new" where the body is `return new(v)`.
	Builtin string `json:"builtin,omitempty"`
}

// inlinesOf reads the inlinable functions a package declares, by name.
func inlinesOf(pkg *packages.Package, qualifier types.Qualifier) map[string]*Inline {
	found := map[string]*Inline{}
	for _, file := range pkg.Syntax {
		for _, declaration := range file.Decls {
			decl, ok := declaration.(*ast.FuncDecl)
			if !ok || decl.Recv != nil || decl.Doc == nil || decl.Body == nil || !hasDirective(decl.Doc, "go:fix inline") {
				continue
			}
			if inline := inlineBody(pkg.TypesInfo, decl, qualifier); inline != nil {
				found[decl.Name.Name] = inline
			}
		}
	}
	return found
}

func hasDirective(group *ast.CommentGroup, directive string) bool {
	for _, comment := range group.List {
		if strings.TrimSpace(comment.Text) == "//"+directive {
			return true
		}
	}
	return false
}

func inlineBody(info *types.Info, decl *ast.FuncDecl, qualifier types.Qualifier) *Inline {
	if len(decl.Body.List) != 1 {
		return nil
	}
	ret, ok := decl.Body.List[0].(*ast.ReturnStmt)
	if !ok || len(ret.Results) != 1 {
		return nil
	}
	call, ok := ret.Results[0].(*ast.CallExpr)
	if !ok || call.Ellipsis.IsValid() {
		return nil
	}
	var params []types.Object
	for _, field := range decl.Type.Params.List {
		for _, name := range field.Names {
			params = append(params, info.Defs[name])
		}
	}
	if len(params) != len(call.Args) {
		return nil
	}
	for index, argument := range call.Args {
		ident, ok := argument.(*ast.Ident)
		if !ok || info.Uses[ident] != params[index] {
			return nil
		}
	}
	callee := call.Fun
	switch fun := callee.(type) {
	case *ast.IndexExpr:
		callee = fun.X
	case *ast.IndexListExpr:
		callee = fun.X
	}
	ident, ok := callee.(*ast.Ident)
	if !ok {
		return nil
	}
	switch object := info.Uses[ident].(type) {
	case *types.Builtin:
		if object.Name() == "new" && len(params) == 1 {
			return &Inline{Builtin: "new"}
		}
	case *types.Func:
		if object.Pkg() == nil || object.Pkg() != info.Defs[decl.Name].Pkg() || object.Type().(*types.Signature).Recv() != nil {
			return nil
		}
		inline := &Inline{To: object.Name()}
		if instance, ok := info.Instances[ident]; ok && instance.TypeArgs != nil {
			for index := 0; index < instance.TypeArgs.Len(); index++ {
				inline.TypeArgs = append(inline.TypeArgs, types.TypeString(instance.TypeArgs.At(index), qualifier))
			}
		}
		return inline
	}
	return nil
}
