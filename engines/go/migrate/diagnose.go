package main

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"sort"

	"golang.org/x/tools/go/ast/astutil"
	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/types/typeutil"
)

// Span is a stretch of a file a person has to look at, and why.
type Span struct {
	File      string `json:"file"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	// Why is `error` for the statement that does not compile, `argument` for
	// where a value it passes is made, `signature` for a function of the
	// consumer's own that forwards such a value, `interface` for an
	// interface method that function implements, and `caller` for a call to
	// either.
	Why string `json:"why"`
}

// Diagnostic is one type error.
type Diagnostic struct {
	File    string `json:"file"`
	Offset  int    `json:"offset"`
	Line    int    `json:"line"`
	Column  int    `json:"column"`
	Message string `json:"message"`
	// Spans are what the error reaches: the statement itself, and, when a
	// call no longer accepts what it is given, where that value comes from.
	Spans []Span `json:"spans,omitempty"`
}

// DiagnoseResponse is what does not compile, and everything it reaches.
type DiagnoseResponse struct {
	Diagnostics []Diagnostic `json:"diagnostics"`
	Errors      []string     `json:"errors,omitempty"`
}

// diagnosticsOf is each type error in a file under `within`, once.
func diagnosticsOf(fset *token.FileSet, loaded []*packages.Package, within string) []Diagnostic {
	seen := map[string]bool{}
	diagnostics := []Diagnostic{}
	for _, pkg := range loaded {
		for _, problem := range pkg.TypeErrors {
			position := fset.Position(problem.Pos)
			if !position.IsValid() || !isWithin(position.Filename, within) {
				continue
			}
			key := fmt.Sprintf("%s:%d:%s", position.Filename, position.Offset, problem.Msg)
			if seen[key] {
				continue
			}
			seen[key] = true
			diagnostics = append(diagnostics, Diagnostic{
				File:    position.Filename,
				Offset:  position.Offset,
				Line:    position.Line,
				Column:  position.Column,
				Message: problem.Msg,
			})
		}
	}
	sort.Slice(diagnostics, func(i, j int) bool {
		a, b := diagnostics[i], diagnostics[j]
		if a.File != b.File {
			return a.File < b.File
		}
		return a.Offset < b.Offset
	})
	return diagnostics
}

// diagnose type-checks the packages, with the overlay's edits, and follows
// each error to everything a person would have to change with it.
//
// An SDK release that changes a method's parameters breaks only the line
// that calls it, but that line is rarely where the work is. On
// cbrgm/sync-secrets-action's move to go-github v89, `DeleteEnvSecret` took
// an owner and a repository instead of a repository ID; the one call that no
// longer compiled sat inside a wrapper, behind an interface, behind two more
// wrappers that forwarded the same ID, and every one of those had to change,
// as did the `Repositories.Get` calls that fetched the ID in the first place.
// So each error is followed from the argument it rejects: to where a local
// value was made, or, when it is the enclosing function's own parameter, to
// that function's signature, the interface methods it implements, and every
// call to either, repeated for as long as the value is passed through.
func diagnose(request Request) (DiagnoseResponse, error) {
	fset, loaded, err := load(request)
	if err != nil {
		return DiagnoseResponse{}, err
	}
	response := DiagnoseResponse{Diagnostics: diagnosticsOf(fset, loaded, request.Within)}
	response.Errors = loadErrors(loaded)
	graph := newCallGraph(fset, filesOf(loaded, request.Within))
	graph.targets = request.Targets
	graph.replaced = request.Replaced
	for index := range response.Diagnostics {
		diagnostic := &response.Diagnostics[index]
		diagnostic.Spans = graph.reach(diagnostic)
	}
	return response, nil
}

// callGraph is what the loaded files declare and call, keyed by where each
// function is declared. With tests loaded, a package is checked more than
// once and its functions are different objects each time; their position in
// the source is the one identity they share.
type callGraph struct {
	fset  *token.FileSet
	files map[string]loadedFile
	// calls to each function or interface method, by its declaration.
	calls map[string][]callSite
	// declarations of functions, and of methods in interfaces, by position.
	funcs      map[string]funcDecl
	interfaces []interfaceMethod
	// targets and replaced say which arguments a call to a method the SDK
	// removed no longer fits (Request.Replaced).
	targets  []string
	replaced map[string][]int
}

type callSite struct {
	file loadedFile
	call *ast.CallExpr
}

type funcDecl struct {
	file   loadedFile
	decl   *ast.FuncDecl
	object *types.Func
}

type interfaceMethod struct {
	file      loadedFile
	field     *ast.Field
	object    *types.Func
	signature string
}

func (g *callGraph) position(pos token.Pos) string {
	position := g.fset.Position(pos)
	return fmt.Sprintf("%s:%d", position.Filename, position.Offset)
}

func newCallGraph(fset *token.FileSet, files []loadedFile) *callGraph {
	graph := &callGraph{
		fset:  fset,
		files: map[string]loadedFile{},
		calls: map[string][]callSite{},
		funcs: map[string]funcDecl{},
	}
	for _, entry := range files {
		graph.files[entry.path] = entry
		file := entry.pkg.Syntax[entry.file]
		info := entry.pkg.TypesInfo
		ast.Inspect(file, func(node ast.Node) bool {
			switch node := node.(type) {
			case *ast.CallExpr:
				if callee, ok := typeutil.Callee(info, node).(*types.Func); ok {
					key := graph.position(callee.Pos())
					graph.calls[key] = append(graph.calls[key], callSite{file: entry, call: node})
				}
			case *ast.FuncDecl:
				if object, ok := info.Defs[node.Name].(*types.Func); ok {
					graph.funcs[graph.position(object.Pos())] = funcDecl{file: entry, decl: node, object: object}
				}
			case *ast.InterfaceType:
				for _, field := range node.Methods.List {
					for _, name := range field.Names {
						if object, ok := info.Defs[name].(*types.Func); ok {
							graph.interfaces = append(graph.interfaces, interfaceMethod{
								file:      entry,
								field:     field,
								object:    object,
								signature: types.TypeString(object.Type(), nil),
							})
						}
					}
				}
			}
			return true
		})
	}
	return graph
}

// reach is every span a diagnostic leads to.
func (g *callGraph) reach(diagnostic *Diagnostic) []Span {
	entry, ok := g.files[diagnostic.File]
	if !ok {
		return nil
	}
	file := entry.pkg.Syntax[entry.file]
	tokenFile := g.fset.File(file.Pos())
	if tokenFile == nil || diagnostic.Offset > tokenFile.Size() {
		return nil
	}
	pos := tokenFile.Pos(diagnostic.Offset)
	path, _ := astutil.PathEnclosingInterval(file, pos, pos)
	walk := &reach{graph: g, seen: map[string]bool{}}
	walk.add(entry, statementOf(path), "error")
	if call := callIn(path); call != nil {
		walk.arguments(entry, call, g.culprits(entry.pkg.TypesInfo, call, pos), path)
	}
	// The error's own statement first, then the rest in source order,
	// whatever order the maps were walked in.
	if len(walk.spans) > 1 {
		rest := walk.spans[1:]
		sort.SliceStable(rest, func(i, j int) bool {
			if rest[i].File != rest[j].File {
				return rest[i].File < rest[j].File
			}
			return rest[i].Start < rest[j].Start
		})
	}
	return walk.spans
}

type reach struct {
	graph *callGraph
	spans []Span
	seen  map[string]bool
}

func (r *reach) add(entry loadedFile, node ast.Node, why string) {
	if node == nil {
		return
	}
	start := r.graph.fset.Position(node.Pos())
	end := r.graph.fset.Position(node.End())
	key := fmt.Sprintf("%s:%d:%d", entry.path, start.Offset, end.Offset)
	if r.seen[key] {
		return
	}
	r.seen[key] = true
	r.spans = append(r.spans, Span{
		File:      entry.path,
		Start:     start.Offset,
		End:       end.Offset,
		StartLine: start.Line,
		EndLine:   end.Line,
		Why:       why,
	})
}

// arguments follows the rejected arguments of a call to where they come from.
func (r *reach) arguments(entry loadedFile, call *ast.CallExpr, indexes []int, path []ast.Node) {
	info := entry.pkg.TypesInfo
	enclosing := enclosingFunc(path)
	for _, index := range indexes {
		if index >= len(call.Args) {
			continue
		}
		for _, variable := range localsIn(info, call.Args[index]) {
			if enclosing != nil {
				if at, isParameter := parameterIndex(info, enclosing, variable); isParameter {
					r.parameter(entry, enclosing, at)
					continue
				}
			}
			for ident, object := range info.Defs {
				if object != variable {
					continue
				}
				definition, _ := astutil.PathEnclosingInterval(entry.pkg.Syntax[entry.file], ident.Pos(), ident.End())
				r.add(entry, statementOf(definition), "argument")
			}
		}
	}
}

// parameter follows a function's parameter that now has to change: its
// signature, the interface methods it implements, and every call to either.
func (r *reach) parameter(entry loadedFile, decl *ast.FuncDecl, index int) {
	object, ok := entry.pkg.TypesInfo.Defs[decl.Name].(*types.Func)
	if !ok {
		return
	}
	key := fmt.Sprintf("%s#%d", r.graph.position(object.Pos()), index)
	if r.seen[key] {
		return
	}
	r.seen[key] = true
	r.add(entry, signatureOf(decl), "signature")
	targets := []string{r.graph.position(object.Pos())}
	if decl.Recv != nil {
		signature := types.TypeString(object.Type(), nil)
		implemented := false
		for _, method := range r.graph.interfaces {
			if method.object.Name() != object.Name() || method.signature != signature {
				continue
			}
			implemented = true
			r.add(method.file, method.field, "interface")
			targets = append(targets, r.graph.position(method.object.Pos()))
		}
		// Every other implementation of that interface method changes with
		// it, or stops implementing it: the other wrappers, and the mocks
		// thegeeklab/wp-github-comment regenerated on go-github 92.
		if implemented {
			for _, other := range r.graph.funcs {
				if other.decl.Recv == nil || other.object == object || other.object.Name() != object.Name() ||
					types.TypeString(other.object.Type(), nil) != signature {
					continue
				}
				r.parameter(other.file, other.decl, index)
			}
		}
	}
	for _, target := range targets {
		for _, site := range r.graph.calls[target] {
			path, _ := astutil.PathEnclosingInterval(site.file.pkg.Syntax[site.file.file], site.call.Pos(), site.call.End())
			r.add(site.file, statementOf(path), "caller")
			r.arguments(site.file, site.call, []int{index}, path)
		}
	}
}

// culprits are the arguments a call no longer accepts: the one an error
// points into, or, where it points at the call as a whole ("not enough
// arguments"), every argument that no longer fits the parameter at its
// place. An argument that still fits stays where it is; `ctx` is not a
// reason to change anything.
func (g *callGraph) culprits(info *types.Info, call *ast.CallExpr, pos token.Pos) []int {
	for index, argument := range call.Args {
		if argument.Pos() <= pos && pos < argument.End() {
			return []int{index}
		}
	}
	if indexes, ok := g.replacedArguments(info, call); ok {
		return indexes
	}
	signature, ok := info.TypeOf(call.Fun).(*types.Signature)
	if !ok {
		return nil
	}
	params := signature.Params()
	var indexes []int
	for index, argument := range call.Args {
		given := info.TypeOf(argument)
		if given == nil {
			continue
		}
		var wanted types.Type
		switch {
		case signature.Variadic() && index >= params.Len()-1:
			wanted = params.At(params.Len() - 1).Type().(*types.Slice).Elem()
		case index < params.Len():
			wanted = params.At(index).Type()
		}
		if wanted == nil || !types.AssignableTo(given, wanted) {
			indexes = append(indexes, index)
		}
	}
	return indexes
}

// replacedArguments are the arguments a call to a method the SDK replaced no
// longer fits: go-github 92 replaced `IssuesService.EditComment`, which took
// an `*IssueComment`, with `UpdateComment`, which takes an
// `IssueCommentRequest`. The call names nothing the new release declares, so
// only what the two releases' surfaces say can tell which argument moves.
func (g *callGraph) replacedArguments(info *types.Info, call *ast.CallExpr) ([]int, bool) {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || len(g.replaced) == 0 || info.Selections[selector] != nil {
		return nil, false
	}
	receiver := info.TypeOf(selector.X)
	if pointer, ok := receiver.(*types.Pointer); ok {
		receiver = pointer.Elem()
	}
	named, ok := receiver.(*types.Named)
	if !ok || named.Obj().Pkg() == nil {
		return nil, false
	}
	path := named.Obj().Pkg().Path()
	if !isTarget(path, g.targets) {
		return nil, false
	}
	key := relativePackage(path, moduleOf(path, g.targets)) + ":" + named.Obj().Name() + "." + selector.Sel.Name
	indexes, ok := g.replaced[key]
	return indexes, ok
}

// localsIn is every variable of a function's own that an expression reads:
// `r` in `int(r.GetID())`, not the method it calls on it.
func localsIn(info *types.Info, expression ast.Expr) []*types.Var {
	var found []*types.Var
	ast.Inspect(expression, func(node ast.Node) bool {
		if selector, ok := node.(*ast.SelectorExpr); ok {
			ast.Inspect(selector.X, func(inner ast.Node) bool {
				if ident, ok := inner.(*ast.Ident); ok {
					found = appendLocal(found, info, ident)
				}
				return true
			})
			return false
		}
		if ident, ok := node.(*ast.Ident); ok {
			found = appendLocal(found, info, ident)
		}
		return true
	})
	return found
}

func appendLocal(found []*types.Var, info *types.Info, ident *ast.Ident) []*types.Var {
	variable, ok := info.Uses[ident].(*types.Var)
	if !ok || variable.IsField() || variable.Parent() == nil || variable.Pkg() == nil {
		return found
	}
	if variable.Parent() == variable.Pkg().Scope() || variable.Parent() == types.Universe {
		return found
	}
	for _, each := range found {
		if each == variable {
			return found
		}
	}
	return append(found, variable)
}

func parameterIndex(info *types.Info, decl *ast.FuncDecl, variable *types.Var) (int, bool) {
	index := 0
	for _, field := range decl.Type.Params.List {
		if len(field.Names) == 0 {
			index++
			continue
		}
		for _, name := range field.Names {
			if info.Defs[name] == variable {
				return index, true
			}
			index++
		}
	}
	return 0, false
}

func enclosingFunc(path []ast.Node) *ast.FuncDecl {
	for _, node := range path {
		switch node := node.(type) {
		case *ast.FuncLit:
			// A closure's parameters are its own; following them would
			// need the call that passes the closure, which is not a call
			// to a name.
			return nil
		case *ast.FuncDecl:
			return node
		}
	}
	return nil
}

// callIn is the innermost call around a position, inside its statement.
func callIn(path []ast.Node) *ast.CallExpr {
	for _, node := range path {
		switch node := node.(type) {
		case *ast.CallExpr:
			return node
		case ast.Stmt, ast.Decl:
			return nil
		}
	}
	return nil
}

// signatureOf spans a function's declaration from `func` to its results,
// not its body.
func signatureOf(decl *ast.FuncDecl) ast.Node {
	return &span{from: decl.Pos(), to: decl.Type.End()}
}

type span struct{ from, to token.Pos }

func (s *span) Pos() token.Pos { return s.from }
func (s *span) End() token.Pos { return s.to }

// statementOf is the smallest statement or declaration around the start of
// a path, but never a block, and never a whole `if` or `for`: an error in an
// `if` statement's init is that init, not every line in its body.
func statementOf(path []ast.Node) ast.Node {
	for index, node := range path {
		switch node.(type) {
		case *ast.BlockStmt, *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt, *ast.SwitchStmt,
			*ast.TypeSwitchStmt, *ast.SelectStmt, *ast.CaseClause, *ast.CommClause,
			*ast.LabeledStmt, *ast.FuncLit, *ast.FuncDecl, *ast.File:
			if index > 0 {
				return path[index-1]
			}
			return node
		case ast.Stmt, *ast.ValueSpec, *ast.TypeSpec, *ast.ImportSpec, *ast.Field:
			return node
		}
	}
	if len(path) > 0 {
		return path[0]
	}
	return nil
}
