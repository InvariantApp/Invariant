package invariant

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Instr is one compiled instruction.
type Instr struct {
	K        string
	Path     []string
	From     []string
	To       []string
	Exp      int
	Map      map[string]string
	Lenient  bool
	Folded   map[string]bool
	CastTo   string
	TimeFrom string
	TimeTo   string
	Truncate bool
	CaseFrom string
	CaseTo   string
	First    bool
	Value    any
	IfAbsent bool
	IfNull   bool
	Block    []*Instr
	Cases    map[string][]*Instr
	Absent   bool
	Kind     string
	Name     string
	// Target is the named block a call runs, shared by every call to it.
	Target *Block
	C      string
}

// Block is a named list of instructions a call runs.
type Block struct{ Instrs []*Instr }

// TransformError is a body that cannot be transformed exactly by a Change.
type TransformError struct {
	ChangeID string
	Message  string
	// Kind tells the refusals apart: "transform", "matches" or "time".
	Kind string
}

func (e *TransformError) Error() string { return e.Message }

// Limits bound what one body may cost.
type Limits struct {
	// MaxMatches caps how many slots one instruction may touch.
	MaxMatches int
	// TimeBudget is the longest one body may take; zero means no limit.
	TimeBudget time.Duration
}

// DefaultLimits are the reference runtime's defaults.
var DefaultLimits = Limits{MaxMatches: 10_000, TimeBudget: 100 * time.Millisecond}

// Result is what running a program did.
type Result struct {
	// Applied counts how many times each Change was applied.
	Applied map[string]int
	// Folded holds the paths where a value was folded.
	Folded map[string]bool
}

const maxCallDepth = 512
const ticksPerRead = 256

type timeExceeded struct{}

func (timeExceeded) Error() string { return "time exceeded" }

type run struct {
	limits   Limits
	result   *Result
	deadline time.Time
	ticks    int
}

// here is where the value a block runs on is held, when a within descended
// to it.
type here struct {
	slot     slot
	removals *[]slot
}

func transformError(instr *Instr, format string, args ...any) error {
	return &TransformError{ChangeID: instr.C, Message: fmt.Sprintf(format, args...), Kind: "transform"}
}

// Execute runs a program over a parsed body, in place.
func Execute(root any, program []*Instr, limits Limits) (*Result, error) {
	r := &run{limits: limits, result: &Result{Applied: map[string]int{}, Folded: map[string]bool{}}}
	if limits.TimeBudget > 0 {
		r.deadline = time.Now().Add(limits.TimeBudget)
	}
	for _, instr := range program {
		if err := r.step(root, instr, 0, nil); err != nil {
			var fan *fanOutExceeded
			var decimalError *DecimalError
			switch {
			case errors.As(err, &fan):
				return nil, &TransformError{
					ChangeID: instr.C,
					Kind:     "matches",
					Message: fmt.Sprintf("%s would touch more than %d places in one body. Raise "+
						"limits.maxMatches if bodies this large are expected.", instr.C, fan.limit),
				}
			case errors.Is(err, timeExceeded{}):
				return nil, &TransformError{
					ChangeID: instr.C,
					Kind:     "time",
					Message: fmt.Sprintf("%s was still running after %s on one body.", instr.C,
						limits.TimeBudget),
				}
			case errors.As(err, &decimalError):
				return nil, transformError(instr, "%s", decimalError.Message)
			}
			return nil, err
		}
	}
	return r.result, nil
}

func (r *run) count(changeID string, times int) {
	if times > 0 {
		r.result.Applied[changeID] += times
	}
}

func joined(path []string) string { return strings.Join(path, "/") }

func hereFor(instr *Instr, h *here) (*here, error) {
	if h == nil {
		return nil, transformError(instr, "An instruction cannot replace a whole body")
	}
	return h, nil
}

func (r *run) block(at any, block []*Instr, calls int, h *here) error {
	for _, inner := range block {
		if err := r.step(at, inner, calls, h); err != nil {
			return err
		}
	}
	return nil
}

func (r *run) step(root any, instr *Instr, calls int, h *here) error {
	if !r.deadline.IsZero() {
		r.ticks++
		if r.ticks%ticksPerRead == 0 && time.Now().After(r.deadline) {
			return timeExceeded{}
		}
	}
	switch instr.K {
	case "move":
		if len(instr.To) == 0 {
			// The value becomes what it holds at From, as an object becomes its id.
			slots, err := resolveSlots(root, instr.From, r.limits.MaxMatches)
			if err != nil || len(slots) == 0 {
				return err
			}
			at, err := hereFor(instr, h)
			if err != nil {
				return err
			}
			value, _ := readSlot(slots[0])
			writeSlot(at.slot, value)
			r.count(instr.C, 1)
			return nil
		}
		moved, err := r.move(root, instr)
		r.count(instr.C, moved)
		return err
	case "scale":
		n, err := r.scale(root, instr)
		r.count(instr.C, n)
		return err
	case "enum":
		n, err := r.enum(root, instr)
		r.count(instr.C, n)
		return err
	case "cast":
		n, err := r.each(root, instr, func(value any) (any, error) { return castValue(value, instr) }, false)
		r.count(instr.C, n)
		return err
	case "time":
		n, err := r.each(root, instr, func(value any) (any, error) {
			return convertTime(value, instr.TimeFrom, instr.TimeTo, instr.Truncate)
		}, true)
		r.count(instr.C, n)
		return err
	case "case":
		n, err := r.each(root, instr, func(value any) (any, error) {
			return convertCase(value, instr.CaseFrom, instr.CaseTo)
		}, true)
		r.count(instr.C, n)
		return err
	case "wrap":
		n, err := r.each(root, instr, func(value any) (any, error) {
			return &Array{Items: []any{value}}, nil
		}, true)
		r.count(instr.C, n)
		return err
	case "unwrap":
		n, err := r.each(root, instr, func(value any) (any, error) { return unwrapped(value, instr.First) }, true)
		r.count(instr.C, n)
		return err
	case "set":
		if len(instr.Path) == 0 {
			at, err := hereFor(instr, h)
			if err != nil {
				return err
			}
			writeSlot(at.slot, Clone(instr.Value))
			r.count(instr.C, 1)
			return nil
		}
		n, err := r.set(root, instr)
		r.count(instr.C, n)
		return err
	case "del":
		if len(instr.Path) == 0 {
			at, err := hereFor(instr, h)
			if err != nil {
				return err
			}
			*at.removals = append(*at.removals, at.slot)
			r.count(instr.C, 1)
			return nil
		}
		n, err := r.del(root, instr)
		r.count(instr.C, n)
		return err
	case "within":
		if len(instr.Path) == 0 {
			if isContainer(root) {
				return r.block(root, instr.Block, calls, h)
			}
			return nil
		}
		slots, err := resolveSlots(root, instr.Path, r.limits.MaxMatches)
		if err != nil {
			return err
		}
		var removals []slot
		for _, s := range slots {
			value, _ := readSlot(s)
			if !isContainer(value) {
				continue
			}
			if err := r.block(value, instr.Block, calls, &here{slot: s, removals: &removals}); err != nil {
				return err
			}
		}
		// Back to front, so removing one list item never moves the next.
		for index := len(removals) - 1; index >= 0; index-- {
			deleteSlot(removals[index])
		}
		return nil
	case "switch":
		// Read once, before anything in the chosen block can change it.
		var value any
		var present bool
		if len(instr.Path) == 0 {
			value, present = root, true
		} else {
			var err error
			value, present, err = readOne(root, instr.Path, r.limits.MaxMatches)
			if err != nil {
				return err
			}
		}
		if !present {
			return nil
		}
		var key string
		switch v := value.(type) {
		case string:
			key = v
		case bool:
			key = fmt.Sprint(v)
		case Number:
			key = string(v)
		default:
			return nil
		}
		return r.block(root, instr.Cases[key], calls, h)
	case "has":
		slots, err := resolveSlots(root, instr.Path, r.limits.MaxMatches)
		if err != nil {
			return err
		}
		if (len(slots) > 0) == instr.Absent {
			return nil
		}
		return r.block(root, instr.Block, calls, h)
	case "is":
		var value any
		var present bool
		if len(instr.Path) == 0 {
			value, present = root, true
		} else {
			var err error
			value, present, err = readOne(root, instr.Path, r.limits.MaxMatches)
			if err != nil {
				return err
			}
		}
		if present && kindOf(value) == instr.Kind {
			return r.block(root, instr.Block, calls, h)
		}
		return nil
	case "call":
		if calls >= maxCallDepth {
			return transformError(instr, "%s called itself too deeply", instr.Name)
		}
		return r.block(root, instr.Target.Instrs, calls+1, h)
	}
	return transformError(instr, "unknown instruction %s", instr.K)
}

func readOne(root any, path []string, limit int) (any, bool, error) {
	slots, err := resolveSlots(root, path, limit)
	if err != nil || len(slots) == 0 {
		return nil, false, err
	}
	value, ok := readSlot(slots[0])
	return value, ok, nil
}

func kindOf(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case Number:
		return "number"
	case *Array:
		return "array"
	case string:
		return "string"
	case bool:
		return "boolean"
	case *Object:
		return "object"
	}
	return ""
}

func (r *run) move(root any, instr *Instr) (int, error) {
	slots, err := resolveSlots(root, instr.From, r.limits.MaxMatches)
	if err != nil {
		return 0, err
	}
	moved := 0
	for _, s := range slots {
		value, _ := readSlot(s)
		target, ok := createSlot(root, instr.To, s.captures)
		if !ok {
			return moved, transformError(instr, "Cannot place the value from %s at %s", joined(instr.From), joined(instr.To))
		}
		deleteSlot(s)
		writeSlot(target, value)
		pruneEmptyAncestors(root, instr.From, s.captures)
		moved++
	}
	return moved, nil
}

func (r *run) scale(root any, instr *Instr) (int, error) {
	slots, err := resolveSlots(root, instr.Path, r.limits.MaxMatches)
	if err != nil {
		return 0, err
	}
	scaled := 0
	for _, s := range slots {
		value, _ := readSlot(s)
		if value == nil {
			continue
		}
		number, ok := value.(Number)
		if !ok {
			return scaled, transformError(instr, "Expected a number at %s to scale, found %s", joined(instr.Path), typeName(value))
		}
		shifted, err := shiftDecimal(string(number), instr.Exp)
		if err != nil {
			return scaled, err
		}
		// Rounding would silently change an amount, so an inexact value is refused.
		if instr.Exp > 0 && strings.Contains(shifted, ".") {
			return scaled, transformError(instr, "Value %s at %s has more precision than the contract allows", number, joined(instr.Path))
		}
		writeSlot(s, Number(shifted))
		scaled++
	}
	return scaled, nil
}

func (r *run) enum(root any, instr *Instr) (int, error) {
	slots, err := resolveSlots(root, instr.Path, r.limits.MaxMatches)
	if err != nil {
		return 0, err
	}
	mapped := 0
	for _, s := range slots {
		value, _ := readSlot(s)
		if value == nil {
			continue
		}
		text, ok := value.(string)
		if !ok {
			return mapped, transformError(instr, "Expected a string at %s to map, found %s", joined(instr.Path), typeName(value))
		}
		replacement, known := instr.Map[text]
		if !known {
			if instr.Lenient {
				continue
			}
			return mapped, transformError(instr, "No mapping for %q at %s in this contract", text, joined(instr.Path))
		}
		if instr.Folded[text] {
			r.result.Folded[joined(instr.Path)] = true
		}
		writeSlot(s, replacement)
		mapped++
	}
	return mapped, nil
}

func castValue(value any, instr *Instr) (any, error) {
	switch instr.CastTo {
	case "string":
		switch v := value.(type) {
		case string:
			return v, nil
		case bool:
			return fmt.Sprint(v), nil
		case Number:
			if _, err := parseDecimal(string(v)); err != nil {
				return nil, err
			}
			return string(v), nil
		}
		return nil, transformError(instr, "Cannot cast %s to string at %s", typeName(value), joined(instr.Path))
	case "boolean":
		if v, ok := value.(bool); ok {
			return v, nil
		}
		return nil, transformError(instr, "Cannot cast %s to boolean at %s", typeName(value), joined(instr.Path))
	case "integer", "number":
		var text string
		switch v := value.(type) {
		case string:
			text = v
		case Number:
			text = string(v)
		default:
			return nil, &DecimalError{fmt.Sprintf("Not a plain decimal number: %v", value)}
		}
		normalized, err := shiftDecimal(text, 0)
		if err != nil {
			return nil, err
		}
		if instr.CastTo == "integer" && strings.Contains(normalized, ".") {
			return nil, transformError(instr, "Value %s at %s is not an integer", text, joined(instr.Path))
		}
		return Number(normalized), nil
	}
	return nil, transformError(instr, "Cannot cast to %s", instr.CastTo)
}

// leaveOut is what a codec returns to take the field away rather than rewrite it.
type leaveOutMarker struct{}

var leaveOut = leaveOutMarker{}

func unwrapped(value any, first bool) (any, error) {
	array, ok := value.(*Array)
	if !ok {
		return nil, refuse("expected a list to unwrap, found %s", typeName(value))
	}
	if first {
		if len(array.Items) == 0 {
			return leaveOut, nil
		}
		return array.Items[0], nil
	}
	if len(array.Items) != 1 {
		return nil, refuse("the list holds %d items, and only one can be shown", len(array.Items))
	}
	return array.Items[0], nil
}

// each rewrites every value at the path, leaving null alone. Codec refusals
// become transform errors naming the path.
func (r *run) each(root any, instr *Instr, convert func(any) (any, error), codec bool) (int, error) {
	slots, err := resolveSlots(root, instr.Path, r.limits.MaxMatches)
	if err != nil {
		return 0, err
	}
	done := 0
	var removals []slot
	for _, s := range slots {
		value, _ := readSlot(s)
		if value == nil {
			continue
		}
		converted, err := convert(value)
		if err != nil {
			var refusal *codecRefusal
			if codec && errors.As(err, &refusal) {
				return done, transformError(instr, "At %s, %s", joined(instr.Path), refusal.message)
			}
			return done, err
		}
		if converted == leaveOut {
			removals = append(removals, s)
		} else {
			writeSlot(s, converted)
		}
		done++
	}
	for index := len(removals) - 1; index >= 0; index-- {
		deleteSlot(removals[index])
	}
	return done, nil
}

func setsOver(instr *Instr, current any, present bool) bool {
	if !instr.IfAbsent && !instr.IfNull {
		return true
	}
	return (instr.IfAbsent && !present) || (instr.IfNull && present && current == nil)
}

func (r *run) set(root any, instr *Instr) (int, error) {
	// Filling a null never creates a field.
	if instr.IfNull && !instr.IfAbsent {
		slots, err := resolveSlots(root, instr.Path, r.limits.MaxMatches)
		if err != nil {
			return 0, err
		}
		written := 0
		for _, s := range slots {
			if value, _ := readSlot(s); value != nil {
				continue
			}
			writeSlot(s, Clone(instr.Value))
			written++
		}
		return written, nil
	}
	// Resolve as far as the last wildcard, then create the rest in each element.
	lastWildcard := -1
	for index, segment := range instr.Path {
		if isWildcard(segment) {
			lastWildcard = index
		}
	}
	if lastWildcard >= 0 {
		elements, err := resolveSlots(root, instr.Path[:lastWildcard+1], r.limits.MaxMatches)
		if err != nil {
			return 0, err
		}
		rest := instr.Path[lastWildcard+1:]
		written := 0
		for _, element := range elements {
			target := element
			if len(rest) > 0 {
				value, _ := readSlot(element)
				created, ok := createSlot(value, rest, nil)
				if !ok {
					continue
				}
				target = created
			}
			current, present := readSlot(target)
			if !setsOver(instr, current, present) {
				continue
			}
			writeSlot(target, Clone(instr.Value))
			written++
		}
		return written, nil
	}
	target, ok := createSlot(root, instr.Path, nil)
	if !ok {
		return 0, transformError(instr, "Cannot write %s", joined(instr.Path))
	}
	current, present := readSlot(target)
	if !setsOver(instr, current, present) {
		return 0, nil
	}
	writeSlot(target, Clone(instr.Value))
	return 1, nil
}

func (r *run) del(root any, instr *Instr) (int, error) {
	slots, err := resolveSlots(root, instr.Path, r.limits.MaxMatches)
	if err != nil {
		return 0, err
	}
	removed := 0
	for index := len(slots) - 1; index >= 0; index-- {
		if instr.IfNull {
			if value, _ := readSlot(slots[index]); value != nil {
				continue
			}
		}
		deleteSlot(slots[index])
		removed++
	}
	return removed, nil
}
