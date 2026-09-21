package invariant

// Form-encoded bodies, as a tree and back.
//
// A program describes fields, not encodings, so the same instructions run
// whether a body arrived as JSON or as a form: the form is decoded into a
// tree, the instructions run, and the tree is written back.
//
// Only the top-level fields a program names are decoded and rewritten, in the
// style each is declared with: bracketed keys for a deepObject, as Stripe
// writes `metadata[order_id]=6735` and `items[0][price]=p_1`, and plain keys
// otherwise, repeated for a list as Twilio writes them. Every other pair keeps
// its exact bytes and its place.

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// FormField says how one top-level field of a form is written.
type FormField struct {
	Style   string
	Explode bool
}

// Form is a site's form declaration.
type Form struct {
	// Fields says how each top-level field is written; one not listed is a
	// plain form field.
	Fields map[string]FormField
	// Types says what each place an instruction reads holds, by pointer with
	// `*` for list items, so a value written as text reaches it typed.
	Types      map[string]string
	typesOrder []string
}

var plainField = FormField{Style: "form", Explode: true}

// maxFormDepth is how deeply a form key may nest, far beyond Stripe's deepest.
const maxFormDepth = 32

// ErrFormTooDeep is a form key nested past maxFormDepth.
var ErrFormTooDeep = errors.New("the body is nested more than " + strconv.Itoa(maxFormDepth) + " levels deep, which is deeper than a transformed operation accepts")

func pairsOf(text string) []queryPair {
	var pairs []queryPair
	for _, pair := range queryPairs(text) {
		if pair.raw != "" {
			pairs = append(pairs, pair)
		}
	}
	return pairs
}

var bracketSegment = regexp.MustCompile(`^\[([^\[\]]*)\]`)

// keyPath is `a[b][0]` as its root and the segments under it; `a[]` ends in
// an append. ok is false for a key that is not bracketed properly.
func keyPath(key string) (root string, segments []string, ok bool, err error) {
	open := strings.IndexByte(key, '[')
	if open == -1 {
		return key, nil, true, nil
	}
	root = key[:open]
	rest := key[open:]
	for rest != "" {
		match := bracketSegment.FindStringSubmatch(rest)
		if match == nil {
			return "", nil, false, nil
		}
		segments = append(segments, match[1])
		if len(segments) > maxFormDepth {
			return "", nil, false, ErrFormTooDeep
		}
		rest = rest[len(match[0]):]
	}
	return root, segments, true, nil
}

// rootOf is the root a pair belongs to, so a named field takes all its pairs.
func rootOf(key string) string {
	if open := strings.IndexByte(key, '['); open != -1 {
		return key[:open]
	}
	return key
}

// listsFromIndexes turns objects whose keys run 0, 1, 2 ... into the lists
// they were written from.
func listsFromIndexes(value any) any {
	switch v := value.(type) {
	case *Array:
		for index, item := range v.Items {
			v.Items[index] = listsFromIndexes(item)
		}
		return v
	case *Object:
		keys := v.Keys()
		for _, key := range keys {
			child, _ := v.Get(key)
			v.Set(key, listsFromIndexes(child))
		}
		if len(keys) == 0 {
			return v
		}
		for index, key := range keys {
			if key != strconv.Itoa(index) {
				return v
			}
		}
		list := &Array{Items: make([]any, len(keys))}
		for index, key := range keys {
			list.Items[index], _ = v.Get(key)
		}
		return list
	}
	return value
}

func bracketed(pairs []queryPair, root string) (any, error) {
	var tree *Object
	for _, pair := range pairs {
		pathRoot, segments, ok, err := keyPath(pair.key)
		if err != nil {
			return nil, err
		}
		if !ok || pathRoot != root {
			continue
		}
		if len(segments) == 0 {
			return pair.value, nil
		}
		if tree == nil {
			tree = NewObject()
		}
		node := tree
		for index, segment := range segments {
			last := index == len(segments)-1
			// `a[]=x` appends, which is a list written without indexes.
			key := segment
			if segment == "" {
				key = strconv.Itoa(node.Len())
			}
			if isUnsafeKey(key) {
				break
			}
			if last {
				node.Set(key, pair.value)
				continue
			}
			next, _ := node.Get(key)
			child, isObject := next.(*Object)
			if !isObject {
				child = NewObject()
				node.Set(key, child)
			}
			node = child
		}
	}
	if tree == nil {
		return nil, nil
	}
	return listsFromIndexes(tree), nil
}

// applyTypes types every leaf the program reads, walking `*` over list items.
func applyTypes(tree *Object, form *Form) {
	for _, pointer := range form.typesOrder {
		kind := form.Types[pointer]
		if kind == "array" || kind == "object" {
			continue
		}
		raw := strings.Split(pointer, "/")[1:]
		segments := make([]string, len(raw))
		for index, segment := range raw {
			segments[index] = strings.ReplaceAll(strings.ReplaceAll(segment, "~1", "/"), "~0", "~")
		}
		if len(segments) == 0 {
			continue
		}
		var visit func(holder any, at int)
		visit = func(holder any, at int) {
			segment := segments[at]
			var keys []string
			switch h := holder.(type) {
			case *Array:
				switch segment {
				case eachItem:
					for index := range h.Items {
						keys = append(keys, strconv.Itoa(index))
					}
				case eachValue:
				default:
					keys = []string{segment}
				}
			case *Object:
				switch segment {
				case eachItem:
				case eachValue:
					for _, key := range h.Keys() {
						if !isUnsafeKey(key) {
							keys = append(keys, key)
						}
					}
				default:
					keys = []string{segment}
				}
			}
			for _, key := range keys {
				child, present := readChild(holder, key)
				if !present {
					continue
				}
				if at == len(segments)-1 {
					typed := child
					if text, isText := child.(string); isText {
						typed = scalar(text, kind)
					}
					switch h := holder.(type) {
					case *Array:
						index, _ := strconv.Atoi(key)
						h.Items[index] = typed
					case *Object:
						h.Set(key, typed)
					}
				} else if isContainer(child) {
					visit(child, at+1)
				}
			}
		}
		visit(tree, 0)
	}
}

// openForm decodes the fields a program names from the form into a tree. Only
// roots are read; a field of the form no instruction names never is.
func openForm(form *Form, roots []string, text string) (*Object, error) {
	pairs := pairsOf(text)
	tree := NewObject()
	for _, root := range roots {
		if isUnsafeKey(root) {
			continue
		}
		field, listed := form.Fields[root]
		if !listed {
			field = plainField
		}
		declared := form.Types["/"+root]
		var mine []queryPair
		nested := false
		for _, pair := range pairs {
			if rootOf(pair.key) == root {
				mine = append(mine, pair)
				nested = nested || pair.key != root
			}
		}
		if len(mine) == 0 {
			continue
		}
		if field.Style == "deepObject" || nested {
			value, err := bracketed(mine, root)
			if err != nil {
				return nil, err
			}
			if value != nil {
				tree.Set(root, value)
			}
			continue
		}
		values := make([]string, len(mine))
		for index, pair := range mine {
			values[index] = pair.value
		}
		switch {
		case declared == "array":
			if !field.Explode {
				values = strings.Split(values[0], ",")
			}
			tree.Set(root, textList(values))
		case declared == "object" && !field.Explode:
			flat := strings.Split(values[0], ",")
			object := NewObject()
			for index := 0; index+1 < len(flat); index += 2 {
				if !isUnsafeKey(flat[index]) {
					object.Set(flat[index], flat[index+1])
				}
			}
			tree.Set(root, object)
		case len(values) == 1:
			tree.Set(root, values[0])
		default:
			tree.Set(root, textList(values))
		}
	}
	applyTypes(tree, form)
	return tree, nil
}

func textList(values []string) *Array {
	list := &Array{Items: make([]any, len(values))}
	for index, value := range values {
		list.Items[index] = value
	}
	return list
}

func formText(value any, changeID, where string) (string, error) {
	switch v := value.(type) {
	case string:
		return v, nil
	case bool:
		if v {
			return "true", nil
		}
		return "false", nil
	case nil:
		// Stripe reads an empty value as "unset", the closest a form comes to null.
		return "", nil
	case Number:
		return string(v), nil
	}
	return "", &TransformError{ChangeID: changeID, Message: where + " holds a value a form cannot write", Kind: "transform"}
}

func encodeKey(root string, segments []string) string {
	var out strings.Builder
	out.WriteString(encodeURIComponent(root))
	for _, segment := range segments {
		out.WriteString("[" + encodeURIComponent(segment) + "]")
	}
	return out.String()
}

// encodeField is one field of the tree as the pairs a form carries it in.
func encodeField(root string, value any, field FormField, changeID string) ([]string, error) {
	var out []string
	var nested func(segments []string, node any) error
	nested = func(segments []string, node any) error {
		switch n := node.(type) {
		case *Array:
			for index, item := range n.Items {
				if err := nested(append(append([]string{}, segments...), strconv.Itoa(index)), item); err != nil {
					return err
				}
			}
			return nil
		case *Object:
			for _, key := range n.Keys() {
				child, _ := n.Get(key)
				if err := nested(append(append([]string{}, segments...), key), child); err != nil {
					return err
				}
			}
			return nil
		}
		text, err := formText(node, changeID, root)
		if err != nil {
			return err
		}
		out = append(out, encodeKey(root, segments)+"="+encodeURIComponent(text))
		return nil
	}

	object, isObject := value.(*Object)
	list, isList := value.(*Array)
	deepList := false
	if isList {
		for _, item := range list.Items {
			if isContainer(item) {
				deepList = true
				break
			}
		}
	}
	if field.Style == "deepObject" || isObject || deepList {
		if field.Style != "deepObject" && isObject && !field.Explode {
			var flat []string
			for _, key := range object.Keys() {
				child, _ := object.Get(key)
				text, err := formText(child, changeID, root)
				if err != nil {
					return nil, err
				}
				flat = append(flat, encodeURIComponent(key), encodeURIComponent(text))
			}
			return []string{encodeURIComponent(root) + "=" + strings.Join(flat, ",")}, nil
		}
		if err := nested(nil, value); err != nil {
			return nil, err
		}
		return out, nil
	}
	if isList {
		items := make([]string, len(list.Items))
		for index, item := range list.Items {
			text, err := formText(item, changeID, root)
			if err != nil {
				return nil, err
			}
			items[index] = encodeURIComponent(text)
		}
		if field.Explode {
			for _, item := range items {
				out = append(out, encodeURIComponent(root)+"="+item)
			}
			return out, nil
		}
		return []string{encodeURIComponent(root) + "=" + strings.Join(items, ",")}, nil
	}
	text, err := formText(value, changeID, root)
	if err != nil {
		return nil, err
	}
	return []string{encodeURIComponent(root) + "=" + encodeURIComponent(text)}, nil
}

// formWriterOf is the change that last wrote under a root, for naming a refusal.
func formWriterOf(instrs []*Instr, root string, depth int) string {
	for index := len(instrs) - 1; index >= 0; index-- {
		for _, path := range touchedPaths(instrs[index], nil) {
			if depth < len(path) && path[depth] == root {
				return instrs[index].C
			}
		}
	}
	if len(instrs) > 0 {
		return instrs[0].C
	}
	return ""
}

// closeForm writes the named fields back. A field the program took away is
// gone; one it moved in is written in the style its declaration gives it.
func closeForm(form *Form, roots []string, original string, tree *Object, instrs []*Instr, depth int) (string, error) {
	named := map[string]bool{}
	for _, root := range roots {
		named[root] = true
	}
	var written []string
	for _, pair := range pairsOf(original) {
		if !named[rootOf(pair.key)] {
			written = append(written, pair.raw)
		}
	}
	for _, root := range tree.Keys() {
		if !named[root] {
			continue
		}
		value, _ := tree.Get(root)
		field, listed := form.Fields[root]
		if !listed {
			field = plainField
		}
		pairs, err := encodeField(root, value, field, formWriterOf(instrs, root, depth))
		if err != nil {
			return "", err
		}
		written = append(written, pairs...)
	}
	return strings.Join(written, "&"), nil
}

// formRoots are the top-level fields a list of instructions names, under
// depth leading segments, in the order they are first named.
func formRoots(instrs []*Instr, depth int) []string {
	var roots []string
	seen := map[string]bool{}
	for _, instr := range instrs {
		for _, path := range touchedPaths(instr, nil) {
			if depth == 1 && (len(path) == 0 || path[0] != "@body") {
				continue
			}
			if depth >= len(path) {
				continue
			}
			root := path[depth]
			if !isWildcard(root) && !seen[root] {
				seen[root] = true
				roots = append(roots, root)
			}
		}
	}
	return roots
}

var formTypes = map[string]bool{"string": true, "integer": true, "number": true, "boolean": true, "array": true, "object": true}

func decodeForm(raw any, where string) (*Form, error) {
	value, err := asObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := expectKeys(value, []string{"fields", "types"}, where); err != nil {
		return nil, err
	}
	form := &Form{Fields: map[string]FormField{}, Types: map[string]string{}}
	fields, err := asObject(field(value, "fields"), where+".fields")
	if err != nil {
		return nil, err
	}
	for _, name := range fields.Keys() {
		at := where + ".fields." + name
		if isUnsafeKey(name) {
			return nil, programError("%s.fields may not name %q", where, name)
		}
		entry, _ := fields.Get(name)
		declared, err := asObject(entry, at)
		if err != nil {
			return nil, err
		}
		if err := expectKeys(declared, []string{"style", "explode"}, at); err != nil {
			return nil, err
		}
		style, _ := field(declared, "style").(string)
		if style != "form" && style != "deepObject" {
			return nil, programError("%s.style must be form or deepObject", at)
		}
		explode, ok := field(declared, "explode").(bool)
		if !ok {
			return nil, programError("%s.explode must be a boolean", at)
		}
		form.Fields[name] = FormField{Style: style, Explode: explode}
	}
	types, err := asObject(field(value, "types"), where+".types")
	if err != nil {
		return nil, err
	}
	for _, pointer := range types.Keys() {
		if _, err := segmentsOf(pointer, where+".types"); err != nil {
			return nil, err
		}
		kind, _ := field(types, pointer).(string)
		if !formTypes[kind] {
			return nil, programError("%s.types[%q] is not a type", where, pointer)
		}
		form.Types[pointer] = kind
		form.typesOrder = append(form.typesOrder, pointer)
	}
	return form, nil
}
