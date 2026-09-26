package main

import (
	"go/ast"
	"go/token"
	"go/types"
)

// FieldRef names a field of one of the SDK's structs as its surface does.
type FieldRef struct {
	Package string `json:"package"`
	Key     string `json:"key"`
}

// tracer follows a value back to the SDK fields it comes from, through the
// consumer's own code: a field read, and the arguments every call in the
// loaded packages passes to a parameter of the consumer's function.
//
// A value of one of the SDK's named types can belong to more than one field:
// an SDK often declares one `CustomerStatus` for a customer's status and for
// the status a request sends. A Change scoped to the response renames the
// value only there, so a literal is rewritten only where every field it
// meets is one the Change covers, and that is something only its fields can
// say, never its type.
type tracer struct {
	fset    *token.FileSet
	targets []string
	names   *keys
	// calls is every call in the loaded files, by where the function called
	// is declared.
	calls map[string][]tracedCall
	// params is every parameter of a function declared in the loaded files,
	// by where it is declared.
	params map[string]parameter
}

type tracedCall struct {
	call *ast.CallExpr
	info *types.Info
}

type parameter struct {
	fn    string
	index int
	// open marks a parameter nothing can follow: variadic, assigned to or
	// having its address taken in the function.
	open bool
}

// maxTrace is how many calls deep a value is followed.
const maxTrace = 4

func newTracer(fset *token.FileSet, files []loadedFile, targets []string, names *keys) *tracer {
	t := &tracer{
		fset:    fset,
		targets: targets,
		names:   names,
		calls:   map[string][]tracedCall{},
		params:  map[string]parameter{},
	}
	for _, entry := range files {
		t.index(entry.pkg.Syntax[entry.file], entry.pkg.TypesInfo)
	}
	return t
}

// index records a file's calls and the parameters of its functions.
func (t *tracer) index(file *ast.File, info *types.Info) {
	ast.Inspect(file, func(node ast.Node) bool {
		switch node := node.(type) {
		case *ast.CallExpr:
			if fn := calledFunc(info, node); fn != nil {
				key := t.position(fn.Pos())
				t.calls[key] = append(t.calls[key], tracedCall{call: node, info: info})
			}
		case *ast.FuncDecl:
			t.indexParameters(info, node)
		}
		return true
	})
}

func (t *tracer) position(pos token.Pos) string {
	return t.fset.Position(pos).String()
}

// calledFunc is the function a call calls by name, and nothing for a method
// expression (`T.M(x, a)`), whose arguments do not line up with its
// parameters.
func calledFunc(info *types.Info, call *ast.CallExpr) *types.Func {
	switch fun := ast.Unparen(call.Fun).(type) {
	case *ast.Ident:
		fn, _ := info.Uses[fun].(*types.Func)
		return fn
	case *ast.SelectorExpr:
		if selection := info.Selections[fun]; selection != nil && selection.Kind() == types.MethodExpr {
			return nil
		}
		fn, _ := info.Uses[fun.Sel].(*types.Func)
		return fn
	}
	return nil
}

func (t *tracer) indexParameters(info *types.Info, decl *ast.FuncDecl) {
	fn, ok := info.Defs[decl.Name].(*types.Func)
	if !ok || decl.Type.Params == nil {
		return
	}
	written := map[types.Object]bool{}
	if decl.Body != nil {
		ast.Inspect(decl.Body, func(node ast.Node) bool {
			switch node := node.(type) {
			case *ast.AssignStmt:
				for _, left := range node.Lhs {
					if ident, ok := ast.Unparen(left).(*ast.Ident); ok {
						written[info.Uses[ident]] = true
					}
				}
			case *ast.IncDecStmt:
				if ident, ok := ast.Unparen(node.X).(*ast.Ident); ok {
					written[info.Uses[ident]] = true
				}
			case *ast.UnaryExpr:
				if ident, ok := ast.Unparen(node.X).(*ast.Ident); ok && node.Op == token.AND {
					written[info.Uses[ident]] = true
				}
			}
			return true
		})
	}
	index := 0
	fields := decl.Type.Params.List
	for position, field := range fields {
		_, variadic := field.Type.(*ast.Ellipsis)
		for _, name := range field.Names {
			variable := info.Defs[name]
			if variable != nil {
				t.params[t.position(variable.Pos())] = parameter{
					fn:    t.position(fn.Pos()),
					index: index,
					open:  (variadic && position == len(fields)-1) || written[variable],
				}
			}
			index++
		}
		if len(field.Names) == 0 {
			index++
		}
	}
}

// unconverted is an expression with parentheses, conversions and pointer
// dereferences taken off: `string(c.Status)` is `c.Status`.
func unconverted(info *types.Info, expression ast.Expr) ast.Expr {
	for {
		switch node := ast.Unparen(expression).(type) {
		case *ast.StarExpr:
			expression = node.X
			continue
		case *ast.CallExpr:
			if len(node.Args) == 1 && info.Types[node.Fun].IsType() {
				expression = node.Args[0]
				continue
			}
		}
		return ast.Unparen(expression)
	}
}

// sdkString is the SDK's named string type a type is, where it is one.
func sdkString(typ types.Type, targets []string) *types.Named {
	named, ok := types.Unalias(typ).(*types.Named)
	if !ok || sdkNamed(named, targets) == nil {
		return nil
	}
	basic, ok := named.Underlying().(*types.Basic)
	if !ok || basic.Info()&types.IsString == 0 {
		return nil
	}
	return named
}

// origin is the SDK fields a value comes from, and whether some of it comes
// from somewhere that could not be followed.
func (t *tracer) origin(info *types.Info, expression ast.Expr, depth int) ([]FieldRef, bool) {
	if depth > maxTrace {
		return nil, true
	}
	switch node := unconverted(info, expression).(type) {
	case *ast.SelectorExpr:
		selection := info.Selections[node]
		if selection == nil || selection.Kind() != types.FieldVal {
			return nil, true
		}
		field, ok := selection.Obj().(*types.Var)
		if !ok || field.Pkg() == nil || !isTarget(field.Pkg().Path(), t.targets) {
			return nil, true
		}
		return []FieldRef{{
			Package: relativePackage(field.Pkg().Path(), moduleOf(field.Pkg().Path(), t.targets)),
			Key:     t.names.of(field),
		}}, false
	case *ast.Ident:
		variable, ok := info.Uses[node].(*types.Var)
		if !ok {
			return nil, true
		}
		param, ok := t.params[t.position(variable.Pos())]
		if !ok || param.open {
			return nil, true
		}
		sites := t.calls[param.fn]
		if len(sites) == 0 {
			return nil, true
		}
		var fields []FieldRef
		for _, site := range sites {
			if site.call.Ellipsis.IsValid() || param.index >= len(site.call.Args) {
				return nil, true
			}
			found, unknown := t.origin(site.info, site.call.Args[param.index], depth+1)
			if unknown {
				return nil, true
			}
			fields = append(fields, found...)
		}
		return fields, false
	}
	return nil, true
}

// fieldOfKey is the SDK field a composite literal's key names.
func (t *tracer) fieldOfKey(info *types.Info, key ast.Expr) ([]FieldRef, bool) {
	ident, ok := key.(*ast.Ident)
	if !ok {
		return nil, true
	}
	field, ok := info.Uses[ident].(*types.Var)
	if !ok || !field.IsField() || field.Pkg() == nil || !isTarget(field.Pkg().Path(), t.targets) {
		return nil, true
	}
	return []FieldRef{{
		Package: relativePackage(field.Pkg().Path(), moduleOf(field.Pkg().Path(), t.targets)),
		Key:     t.names.of(field),
	}}, false
}

// meets is what a string literal is compared with or given as: the SDK's
// named string type it is a value of, the fields that value meets, and
// whether some place it meets could not be followed. A literal of no SDK
// type, compared with nothing that has one, gives no type.
func (t *tracer) meets(info *types.Info, literal *ast.BasicLit, stack []ast.Node) (*types.Named, []FieldRef, bool) {
	named := sdkString(info.TypeOf(literal), t.targets)
	node := ast.Node(literal)
	at := len(stack) - 1
	// Up through parentheses and a conversion to the SDK's type:
	// `sdk.CustomerStatus("active")`.
	for at >= 0 {
		switch parent := stack[at].(type) {
		case *ast.ParenExpr:
			node = parent
			at--
			continue
		case *ast.CallExpr:
			if len(parent.Args) == 1 && parent.Args[0] == node && info.Types[parent.Fun].IsType() {
				if converted := sdkString(info.TypeOf(parent), t.targets); converted != nil {
					named = converted
				}
				node = parent
				at--
				continue
			}
		}
		break
	}
	if at < 0 {
		return named, nil, true
	}
	// The type a value it is compared with has once its conversion is taken
	// off: `string(c.Status) == "active"` compares with a `CustomerStatus`.
	through := func(other ast.Expr) {
		if named == nil {
			named = sdkString(info.TypeOf(unconverted(info, other)), t.targets)
		}
	}
	switch parent := stack[at].(type) {
	case *ast.BinaryExpr:
		if parent.Op != token.EQL && parent.Op != token.NEQ {
			return named, nil, true
		}
		other := parent.X
		if other == node {
			other = parent.Y
		}
		through(other)
		fields, unknown := t.origin(info, other, 0)
		return named, fields, unknown
	case *ast.CaseClause:
		// A case clause's parents are the switch's body and the switch.
		if at < 2 {
			return named, nil, true
		}
		switched, ok := stack[at-2].(*ast.SwitchStmt)
		if !ok || switched.Tag == nil {
			return named, nil, true
		}
		through(switched.Tag)
		fields, unknown := t.origin(info, switched.Tag, 0)
		return named, fields, unknown
	case *ast.KeyValueExpr:
		if parent.Value != node || at < 1 {
			return named, nil, true
		}
		if _, isStruct := stack[at-1].(*ast.CompositeLit); !isStruct {
			return named, nil, true
		}
		fields, unknown := t.fieldOfKey(info, parent.Key)
		return named, fields, unknown
	case *ast.CompositeLit:
		// An item of a list a value is looked for in:
		// `slices.Contains([]sdk.CustomerStatus{"active"}, c.Status)`.
		if at < 1 {
			return named, nil, true
		}
		call, ok := stack[at-1].(*ast.CallExpr)
		fn := (*types.Func)(nil)
		if ok {
			fn = calledFunc(info, call)
		}
		if fn == nil || fn.Pkg() == nil || fn.Pkg().Path() != "slices" ||
			(fn.Name() != "Contains" && fn.Name() != "Index") ||
			len(call.Args) != 2 || call.Args[0] != parent {
			return named, nil, true
		}
		through(call.Args[1])
		fields, unknown := t.origin(info, call.Args[1], 0)
		return named, fields, unknown
	case *ast.AssignStmt:
		if len(parent.Lhs) != len(parent.Rhs) {
			return named, nil, true
		}
		for index, value := range parent.Rhs {
			if value == node {
				fields, unknown := t.origin(info, parent.Lhs[index], 0)
				return named, fields, unknown
			}
		}
	}
	return named, nil, true
}

// holdsSDKData says whether a variable provably holds what the SDK returned
// or is handed to it: it is assigned the result of a call into the SDK, or
// read by index from another variable that does, or decoded from bytes that
// do, or passed to a call into the SDK. A map's keys are read by name, and
// only this makes them the SDK's; a map decoded from anything else is the
// consumer's own, whatever its keys spell.
func (t *tracer) holdsSDKData(info *types.Info, variable *types.Var, body ast.Node, depth int) bool {
	if depth > maxTrace || body == nil {
		return false
	}
	sdkCall := func(expression ast.Expr) bool {
		call, ok := ast.Unparen(expression).(*ast.CallExpr)
		if !ok {
			return false
		}
		fn := calledFunc(info, call)
		return fn != nil && fn.Pkg() != nil && isTarget(fn.Pkg().Path(), t.targets)
	}
	is := func(expression ast.Expr, target *types.Var) bool {
		expression = ast.Unparen(expression)
		if unary, ok := expression.(*ast.UnaryExpr); ok && unary.Op == token.AND {
			expression = ast.Unparen(unary.X)
		}
		ident, ok := expression.(*ast.Ident)
		if !ok {
			return false
		}
		object := info.Uses[ident]
		if object == nil {
			object = info.Defs[ident]
		}
		return object == target
	}
	// The variable an index or type assertion chain is read from.
	base := func(expression ast.Expr) *types.Var {
		for {
			switch node := ast.Unparen(expression).(type) {
			case *ast.IndexExpr:
				expression = node.X
			case *ast.TypeAssertExpr:
				expression = node.X
			case *ast.Ident:
				object, _ := info.Uses[node].(*types.Var)
				return object
			default:
				return nil
			}
		}
	}
	from := func(value ast.Expr) bool {
		if sdkCall(value) {
			return true
		}
		other := base(value)
		return other != nil && other != variable && t.holdsSDKData(info, other, body, depth+1)
	}
	found := false
	ast.Inspect(body, func(node ast.Node) bool {
		if found {
			return false
		}
		switch node := node.(type) {
		case *ast.AssignStmt:
			for index, left := range node.Lhs {
				if !is(left, variable) {
					continue
				}
				if len(node.Rhs) == len(node.Lhs) && from(node.Rhs[index]) {
					found = true
				} else if len(node.Rhs) == 1 && sdkCall(node.Rhs[0]) {
					found = true
				}
			}
		case *ast.ValueSpec:
			for index, name := range node.Names {
				if info.Defs[name] == variable && index < len(node.Values) && from(node.Values[index]) {
					found = true
				}
			}
		case *ast.CallExpr:
			fn := calledFunc(info, node)
			if fn == nil || fn.Pkg() == nil {
				return true
			}
			if isTarget(fn.Pkg().Path(), t.targets) {
				for _, argument := range node.Args {
					if is(argument, variable) {
						found = true
					}
				}
				return true
			}
			// `json.Unmarshal(body, &event)` with a body the SDK returned.
			if fn.Pkg().Path() == "encoding/json" && fn.Name() == "Unmarshal" && len(node.Args) == 2 &&
				is(node.Args[1], variable) {
				if bytes := base(node.Args[0]); bytes != nil && bytes != variable &&
					t.holdsSDKData(info, bytes, body, depth+1) {
					found = true
				}
			}
		}
		return !found
	})
	return found
}
