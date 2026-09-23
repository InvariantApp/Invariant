package invariant

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ProgramError is a program this engine refuses to load. A refused program is
// never partly run.
type ProgramError struct{ Message string }

func (e *ProgramError) Error() string { return e.Message }

func programError(format string, args ...any) error {
	return &ProgramError{fmt.Sprintf(format, args...)}
}

// ProgramVersion is the program format this engine reads.
const ProgramVersion = 2

// maxBlockDepth is how deeply blocks may nest.
const maxBlockDepth = 8

var pointerSegment = regexp.MustCompile(`^([^/~]|~[01])*$`)

func asObject(value any, where string) (*Object, error) {
	object, ok := value.(*Object)
	if !ok {
		return nil, programError("%s must be an object", where)
	}
	return object, nil
}

func asString(value any, where string) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", programError("%s must be a string", where)
	}
	return text, nil
}

func asArray(value any, where string) ([]any, error) {
	array, ok := value.(*Array)
	if !ok {
		return nil, programError("%s must be an array", where)
	}
	return array.Items, nil
}

func expectKeys(value *Object, allowed []string, where string) error {
	for _, key := range value.Keys() {
		found := false
		for _, each := range allowed {
			if each == key {
				found = true
				break
			}
		}
		if !found {
			return programError("%s has an unexpected field %q", where, key)
		}
	}
	return nil
}

func field(value *Object, key string) any {
	out, _ := value.Get(key)
	return out
}

func stringField(value *Object, key, where string) (string, error) {
	present, ok := value.Get(key)
	if !ok {
		return "", programError("%s.%s must be a string", where, key)
	}
	return asString(present, where+"."+key)
}

// onlyTrue reads a flag that is either left out or true, never anything else.
func onlyTrue(value *Object, key, where string) (bool, error) {
	present, ok := value.Get(key)
	if !ok {
		return false, nil
	}
	if present != true {
		return false, programError("%s.%s must be true when present", where, key)
	}
	return true, nil
}

func segmentsOf(pointer, where string) ([]string, error) {
	if pointer == "" {
		return []string{}, nil
	}
	if !strings.HasPrefix(pointer, "/") {
		return nil, programError("%s must be a JSON Pointer, got %q", where, pointer)
	}
	raw := strings.Split(pointer[1:], "/")
	out := make([]string, len(raw))
	for index, segment := range raw {
		if segment != "*" && !pointerSegment.MatchString(segment) {
			return nil, programError("%s has an invalid segment %q", where, segment)
		}
		decoded := segment
		if !isWildcard(segment) {
			decoded = strings.ReplaceAll(strings.ReplaceAll(segment, "~1", "/"), "~0", "~")
		}
		if isUnsafeKey(decoded) {
			return nil, programError("%s may not name %q", where, decoded)
		}
		out[index] = decoded
	}
	return out, nil
}

func pathField(value *Object, key, where string) ([]string, error) {
	text, err := stringField(value, key, where)
	if err != nil {
		return nil, err
	}
	return segmentsOf(text, where+"."+key)
}

func wildcardsOf(segments []string) string {
	var out []string
	for _, segment := range segments {
		if isWildcard(segment) {
			out = append(out, segment)
		}
	}
	return strings.Join(out, ",")
}

type blocks map[string]*Block

func decodeBlock(raw any, where string, depth int, named blocks, descended bool) ([]*Instr, error) {
	if depth > maxBlockDepth {
		return nil, programError("%s nests blocks more than %d deep", where, maxBlockDepth)
	}
	items, err := asArray(raw, where)
	if err != nil {
		return nil, err
	}
	out := make([]*Instr, len(items))
	for index, item := range items {
		instr, err := decodeInstr(item, fmt.Sprintf("%s[%d]", where, index), depth, named, descended)
		if err != nil {
			return nil, err
		}
		out[index] = instr
	}
	return out, nil
}

var jsonKinds = map[string]bool{"object": true, "array": true, "string": true, "number": true, "boolean": true, "null": true}
var scalars = map[string]bool{"string": true, "integer": true, "number": true, "boolean": true}
var timeFormats = map[string]bool{"epoch-s": true, "epoch-ms": true, "rfc3339": true}
var stringCases = map[string]bool{"snake": true, "screaming": true, "kebab": true, "camel": true, "pascal": true}

func decodeInstr(raw any, where string, depth int, named blocks, descended bool) (*Instr, error) {
	itself := func(path []string, name string) error {
		if len(path) == 0 && !descended {
			return programError("%s.%s writes a whole body, which only a value inside one can be", where, name)
		}
		return nil
	}
	value, err := asObject(raw, where)
	if err != nil {
		return nil, err
	}
	kind, err := stringField(value, "k", where)
	if err != nil {
		return nil, err
	}
	changeID, err := stringField(value, "c", where)
	if err != nil {
		return nil, err
	}
	instr := &Instr{K: kind, C: changeID}

	switch kind {
	case "within":
		if err := expectKeys(value, []string{"k", "path", "block", "c"}, where); err != nil {
			return nil, err
		}
		if instr.Path, err = pathField(value, "path", where); err != nil {
			return nil, err
		}
		instr.Block, err = decodeBlock(field(value, "block"), where+".block", depth+1, named, descended || len(instr.Path) > 0)
		return instr, err
	case "call":
		if err := expectKeys(value, []string{"k", "block", "c"}, where); err != nil {
			return nil, err
		}
		if instr.Name, err = stringField(value, "block", where); err != nil {
			return nil, err
		}
		target, ok := named[instr.Name]
		if !ok {
			return nil, programError("%s calls %q, which is no block", where, instr.Name)
		}
		instr.Target = target
		return instr, nil
	case "switch", "has", "is":
		if instr.Path, err = pathField(value, "path", where); err != nil {
			return nil, err
		}
		for _, segment := range instr.Path {
			if isWildcard(segment) {
				return nil, programError("%s.path reads a key through a wildcard", where)
			}
		}
		switch kind {
		case "has":
			if err := expectKeys(value, []string{"k", "path", "block", "absent", "c"}, where); err != nil {
				return nil, err
			}
			if len(instr.Path) == 0 {
				return nil, programError("%s.path names nothing", where)
			}
			if instr.Block, err = decodeBlock(field(value, "block"), where+".block", depth+1, named, descended); err != nil {
				return nil, err
			}
			instr.Absent, err = onlyTrue(value, "absent", where)
			return instr, err
		case "is":
			if err := expectKeys(value, []string{"k", "path", "type", "block", "c"}, where); err != nil {
				return nil, err
			}
			kindName, _ := field(value, "type").(string)
			if !jsonKinds[kindName] {
				return nil, programError("%s.type is not a JSON type", where)
			}
			instr.Kind = kindName
			instr.Block, err = decodeBlock(field(value, "block"), where+".block", depth+1, named, descended)
			return instr, err
		}
		if err := expectKeys(value, []string{"k", "path", "cases", "c"}, where); err != nil {
			return nil, err
		}
		cases, err := asObject(field(value, "cases"), where+".cases")
		if err != nil {
			return nil, err
		}
		instr.Cases = map[string][]*Instr{}
		for _, key := range cases.Keys() {
			block, _ := cases.Get(key)
			decoded, err := decodeBlock(block, where+".cases."+key, depth+1, named, descended)
			if err != nil {
				return nil, err
			}
			instr.Cases[key] = decoded
		}
		return instr, nil
	case "move":
		if err := expectKeys(value, []string{"k", "from", "to", "c"}, where); err != nil {
			return nil, err
		}
		if instr.From, err = pathField(value, "from", where); err != nil {
			return nil, err
		}
		if instr.To, err = pathField(value, "to", where); err != nil {
			return nil, err
		}
		if wildcardsOf(instr.From) != wildcardsOf(instr.To) {
			return nil, programError("%s moves between paths whose wildcards do not line up", where)
		}
		if len(instr.From) == 0 {
			return nil, programError("%s cannot move the document root", where)
		}
		return instr, itself(instr.To, "to")
	case "scale":
		if err := expectKeys(value, []string{"k", "path", "exp", "c"}, where); err != nil {
			return nil, err
		}
		number, ok := field(value, "exp").(Number)
		exp, parseErr := strconv.Atoi(string(number))
		if !ok || parseErr != nil || exp < -9 || exp > 9 {
			return nil, programError("%s.exp must be an integer between -9 and 9", where)
		}
		instr.Exp = exp
		instr.Path, err = pathField(value, "path", where)
		return instr, err
	case "enum":
		if err := expectKeys(value, []string{"k", "path", "map", "lenient", "folded", "c"}, where); err != nil {
			return nil, err
		}
		if lenient, present := value.Get("lenient"); present {
			flag, ok := lenient.(bool)
			if !ok {
				return nil, programError("%s.lenient must be a boolean", where)
			}
			instr.Lenient = flag
		}
		mapping, err := asObject(field(value, "map"), where+".map")
		if err != nil {
			return nil, err
		}
		instr.Map = map[string]string{}
		for _, key := range mapping.Keys() {
			to, _ := mapping.Get(key)
			text, err := asString(to, where+".map."+key)
			if err != nil {
				return nil, err
			}
			instr.Map[key] = text
		}
		if rawFolded, present := value.Get("folded"); present {
			items, err := asArray(rawFolded, where+".folded")
			if err != nil {
				return nil, err
			}
			instr.Folded = map[string]bool{}
			for index, item := range items {
				key, err := asString(item, fmt.Sprintf("%s.folded[%d]", where, index))
				if err != nil {
					return nil, err
				}
				if _, known := instr.Map[key]; !known {
					return nil, programError("%s.folded names %q, which the map does not", where, key)
				}
				instr.Folded[key] = true
			}
		}
		instr.Path, err = pathField(value, "path", where)
		return instr, err
	case "cast":
		if err := expectKeys(value, []string{"k", "path", "to", "c"}, where); err != nil {
			return nil, err
		}
		to, err := stringField(value, "to", where)
		if err != nil {
			return nil, err
		}
		if !scalars[to] {
			return nil, programError("%s.to is not a scalar type", where)
		}
		instr.CastTo = to
		instr.Path, err = pathField(value, "path", where)
		return instr, err
	case "time":
		if err := expectKeys(value, []string{"k", "path", "from", "to", "truncate", "c"}, where); err != nil {
			return nil, err
		}
		from, errFrom := stringField(value, "from", where)
		to, errTo := stringField(value, "to", where)
		if errFrom != nil {
			return nil, errFrom
		}
		if errTo != nil {
			return nil, errTo
		}
		if !timeFormats[from] || !timeFormats[to] || from == to {
			return nil, programError("%s must name two different time formats", where)
		}
		instr.TimeFrom, instr.TimeTo = from, to
		if instr.Path, err = pathField(value, "path", where); err != nil {
			return nil, err
		}
		instr.Truncate, err = onlyTrue(value, "truncate", where)
		return instr, err
	case "case":
		if err := expectKeys(value, []string{"k", "path", "from", "to", "c"}, where); err != nil {
			return nil, err
		}
		from, errFrom := stringField(value, "from", where)
		to, errTo := stringField(value, "to", where)
		if errFrom != nil {
			return nil, errFrom
		}
		if errTo != nil {
			return nil, errTo
		}
		if !stringCases[from] || !stringCases[to] || from == to {
			return nil, programError("%s must name two different cases", where)
		}
		instr.CaseFrom, instr.CaseTo = from, to
		instr.Path, err = pathField(value, "path", where)
		return instr, err
	case "wrap":
		if err := expectKeys(value, []string{"k", "path", "c"}, where); err != nil {
			return nil, err
		}
		instr.Path, err = pathField(value, "path", where)
		return instr, err
	case "unwrap":
		if err := expectKeys(value, []string{"k", "path", "first", "c"}, where); err != nil {
			return nil, err
		}
		if instr.Path, err = pathField(value, "path", where); err != nil {
			return nil, err
		}
		instr.First, err = onlyTrue(value, "first", where)
		return instr, err
	case "drop":
		if err := expectKeys(value, []string{"k", "path", "values", "c"}, where); err != nil {
			return nil, err
		}
		if instr.Path, err = pathField(value, "path", where); err != nil {
			return nil, err
		}
		list, ok := field(value, "values").(*Array)
		if !ok || len(list.Items) == 0 {
			return nil, programError("%s.values must be a list of strings", where)
		}
		instr.Drop = make(map[string]bool, len(list.Items))
		for _, entry := range list.Items {
			text, isText := entry.(string)
			if !isText {
				return nil, programError("%s.values must be a list of strings", where)
			}
			instr.Drop[text] = true
		}
		return instr, nil
	case "set":
		if err := expectKeys(value, []string{"k", "path", "value", "ifAbsent", "ifNull", "c"}, where); err != nil {
			return nil, err
		}
		ifAbsent, ok := field(value, "ifAbsent").(bool)
		if !ok {
			return nil, programError("%s.ifAbsent must be a boolean", where)
		}
		if instr.Path, err = pathField(value, "path", where); err != nil {
			return nil, err
		}
		if err := itself(instr.Path, "path"); err != nil {
			return nil, err
		}
		_, hasIfNull := value.Get("ifNull")
		if len(instr.Path) == 0 && (ifAbsent || hasIfNull) {
			return nil, programError("%s replaces the value itself, which is never absent", where)
		}
		instr.Value = field(value, "value")
		instr.IfAbsent = ifAbsent
		instr.IfNull, err = onlyTrue(value, "ifNull", where)
		return instr, err
	case "del":
		if err := expectKeys(value, []string{"k", "path", "ifNull", "c"}, where); err != nil {
			return nil, err
		}
		if instr.Path, err = pathField(value, "path", where); err != nil {
			return nil, err
		}
		if err := itself(instr.Path, "path"); err != nil {
			return nil, err
		}
		if _, hasIfNull := value.Get("ifNull"); len(instr.Path) == 0 && hasIfNull {
			return nil, programError("%s removes the value itself, which is never null", where)
		}
		instr.IfNull, err = onlyTrue(value, "ifNull", where)
		return instr, err
	}
	return nil, programError("%s has an unknown instruction %q", where, kind)
}

// refuseStandingCycles refuses blocks that could call one another forever on
// one value: a cycle of calls none of which descends into the value.
func refuseStandingCycles(named blocks, order []string, where string) error {
	var standing func(instrs []*Instr, into map[string]bool)
	standing = func(instrs []*Instr, into map[string]bool) {
		for _, instr := range instrs {
			switch {
			case instr.K == "call":
				into[instr.Name] = true
			case instr.K == "within" && len(instr.Path) == 0:
				standing(instr.Block, into)
			case instr.K == "has" || instr.K == "is":
				standing(instr.Block, into)
			case instr.K == "switch":
				for _, block := range instr.Cases {
					standing(block, into)
				}
			}
		}
	}
	edges := map[string]map[string]bool{}
	for name, holder := range named {
		into := map[string]bool{}
		standing(holder.Instrs, into)
		edges[name] = into
	}
	state := map[string]string{}
	var visit func(name string, trail []string) error
	visit = func(name string, trail []string) error {
		switch state[name] {
		case "done":
			return nil
		case "open":
			return programError("%s call one another without descending: %s", where, strings.Join(append(trail, name), " -> "))
		}
		state[name] = "open"
		for next := range edges[name] {
			if err := visit(next, append(append([]string{}, trail...), name)); err != nil {
				return err
			}
		}
		state[name] = "done"
		return nil
	}
	for _, name := range order {
		if err := visit(name, nil); err != nil {
			return err
		}
	}
	return nil
}

// decodeBlocks reads named blocks, able to call one another and any in shared.
func decodeBlocks(raw any, where string, shared blocks) (blocks, error) {
	if raw == nil {
		return shared, nil
	}
	entries, err := asObject(raw, where)
	if err != nil {
		return nil, err
	}
	named := blocks{}
	for name, block := range shared {
		named[name] = block
	}
	for _, name := range entries.Keys() {
		if name == "" || len(name) > 256 {
			return nil, programError("%s has a block name that is empty or too long", where)
		}
		if _, taken := shared[name]; taken {
			return nil, programError("%s declares %s, which the program already does", where, name)
		}
		named[name] = &Block{}
	}
	for _, name := range entries.Keys() {
		list, _ := entries.Get(name)
		instrs, err := decodeBlock(list, fmt.Sprintf("%s[%q]", where, name), 0, named, true)
		if err != nil {
			return nil, err
		}
		named[name].Instrs = instrs
	}
	order := append([]string{}, entries.Keys()...)
	for name := range shared {
		order = append(order, name)
	}
	if err := refuseStandingCycles(named, order, where); err != nil {
		return nil, err
	}
	return named, nil
}
