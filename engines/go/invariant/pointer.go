package invariant

import (
	"strconv"
)

// The path language is JSON Pointer plus two wildcard segments: `*` for every
// item of a list, and `{}` for every value of a map.
const (
	eachItem  = "*"
	eachValue = "{}"
)

func isWildcard(segment string) bool { return segment == eachItem || segment == eachValue }

// unsafeKeys would reach outside the document in the reference runtime, and
// are refused here too so the two engines agree on every program.
var unsafeKeys = map[string]bool{"__proto__": true, "constructor": true, "prototype": true}

func isUnsafeKey(key string) bool { return unsafeKeys[key] }

// A capture is where a wildcard went: a list index (int) or a map key (string).
type capture = any

// slot is a place a value is held: in an object under a key, or in a list at
// an index.
type slot struct {
	object   *Object
	array    *Array
	key      string
	index    int
	captures []capture
}

// fanOutExceeded is a path selecting more slots than an instruction may touch.
type fanOutExceeded struct{ limit int }

func (e *fanOutExceeded) Error() string { return "more than " + strconv.Itoa(e.limit) + " matches" }

func isContainer(value any) bool {
	switch value.(type) {
	case *Object, *Array:
		return true
	}
	return false
}

func readChild(container any, key string) (any, bool) {
	switch c := container.(type) {
	case *Array:
		index, err := strconv.Atoi(key)
		if err != nil || index < 0 || index >= len(c.Items) || strconv.Itoa(index) != key {
			return nil, false
		}
		return c.Items[index], true
	case *Object:
		return c.Get(key)
	}
	return nil, false
}

func withCapture(captures []capture, next capture) []capture {
	out := make([]capture, len(captures)+1)
	copy(out, captures)
	out[len(captures)] = next
	return out
}

type node struct {
	value    any
	captures []capture
}

// resolveSlots returns every existing slot a path selects.
func resolveSlots(root any, segments []string, limit int) ([]slot, error) {
	if len(segments) == 0 {
		return nil, nil
	}
	frontier := []node{{value: root}}
	for depth := 0; depth < len(segments)-1; depth++ {
		segment := segments[depth]
		var next []node
		for _, n := range frontier {
			if !isContainer(n.value) {
				continue
			}
			switch {
			case segment == eachItem:
				array, ok := n.value.(*Array)
				if !ok {
					continue
				}
				for index, item := range array.Items {
					if len(next) >= limit {
						return nil, &fanOutExceeded{limit}
					}
					next = append(next, node{value: item, captures: withCapture(n.captures, index)})
				}
			case segment == eachValue:
				object, ok := n.value.(*Object)
				if !ok {
					continue
				}
				for _, key := range object.Keys() {
					if isUnsafeKey(key) {
						continue
					}
					if len(next) >= limit {
						return nil, &fanOutExceeded{limit}
					}
					child, _ := object.Get(key)
					next = append(next, node{value: child, captures: withCapture(n.captures, key)})
				}
			default:
				child, ok := readChild(n.value, segment)
				if !ok {
					continue
				}
				next = append(next, node{value: child, captures: n.captures})
			}
		}
		frontier = next
		if len(frontier) == 0 {
			return nil, nil
		}
	}

	last := segments[len(segments)-1]
	var slots []slot
	for _, n := range frontier {
		switch container := n.value.(type) {
		case *Array:
			if last != eachItem {
				continue
			}
			for index := range container.Items {
				if len(slots) >= limit {
					return nil, &fanOutExceeded{limit}
				}
				slots = append(slots, slot{array: container, index: index, key: strconv.Itoa(index), captures: withCapture(n.captures, index)})
			}
		case *Object:
			if last == eachItem {
				continue
			}
			if last == eachValue {
				for _, key := range container.Keys() {
					if isUnsafeKey(key) {
						continue
					}
					if len(slots) >= limit {
						return nil, &fanOutExceeded{limit}
					}
					slots = append(slots, slot{object: container, key: key, captures: withCapture(n.captures, key)})
				}
				continue
			}
			if _, ok := container.Get(last); !ok {
				continue
			}
			if len(slots) >= limit {
				return nil, &fanOutExceeded{limit}
			}
			slots = append(slots, slot{object: container, key: last, captures: n.captures})
		}
	}
	return slots, nil
}

func readSlot(s slot) (any, bool) {
	if s.array != nil {
		if s.index < 0 || s.index >= len(s.array.Items) {
			return nil, false
		}
		return s.array.Items[s.index], true
	}
	return s.object.Get(s.key)
}

func writeSlot(s slot, value any) {
	if s.array != nil {
		if s.index >= 0 && s.index < len(s.array.Items) {
			s.array.Items[s.index] = value
		}
		return
	}
	if isUnsafeKey(s.key) {
		return
	}
	s.object.Set(s.key, value)
}

func deleteSlot(s slot) {
	if s.array != nil {
		if s.index >= 0 && s.index < len(s.array.Items) {
			s.array.Items = append(s.array.Items[:s.index], s.array.Items[s.index+1:]...)
		}
		return
	}
	s.object.Delete(s.key)
}

// createSlot walks to a slot, creating objects along the way. Wildcards are
// filled from captures, so a target lines up with the source that produced it.
func createSlot(root any, segments []string, captures []capture) (slot, bool) {
	if len(segments) == 0 {
		return slot{}, false
	}
	current := root
	captureIndex := 0
	for depth := 0; depth < len(segments)-1; depth++ {
		raw := segments[depth]
		if !isContainer(current) {
			return slot{}, false
		}
		switch raw {
		case eachItem:
			if captureIndex >= len(captures) {
				return slot{}, false
			}
			index, ok := captures[captureIndex].(int)
			captureIndex++
			array, isArray := current.(*Array)
			if !ok || !isArray || index >= len(array.Items) {
				return slot{}, false
			}
			current = array.Items[index]
			continue
		case eachValue:
			if captureIndex >= len(captures) {
				return slot{}, false
			}
			key, ok := captures[captureIndex].(string)
			captureIndex++
			object, isObject := current.(*Object)
			if !ok || !isObject || isUnsafeKey(key) {
				return slot{}, false
			}
			child, present := object.Get(key)
			if !present {
				return slot{}, false
			}
			current = child
			continue
		}
		object, isObject := current.(*Object)
		if !isObject || isUnsafeKey(raw) {
			return slot{}, false
		}
		child, present := object.Get(raw)
		if !present || !isContainer(child) {
			if present {
				return slot{}, false
			}
			created := NewObject()
			object.Set(raw, created)
			child = created
		}
		current = child
	}

	last := segments[len(segments)-1]
	switch container := current.(type) {
	case *Array:
		if last != eachItem || captureIndex >= len(captures) {
			return slot{}, false
		}
		index, ok := captures[captureIndex].(int)
		if !ok {
			return slot{}, false
		}
		return slot{array: container, index: index, key: strconv.Itoa(index), captures: captures}, true
	case *Object:
		if last == eachItem {
			return slot{}, false
		}
		if last == eachValue {
			if captureIndex >= len(captures) {
				return slot{}, false
			}
			key, ok := captures[captureIndex].(string)
			if !ok || isUnsafeKey(key) {
				return slot{}, false
			}
			return slot{object: container, key: key, captures: captures}, true
		}
		if isUnsafeKey(last) {
			return slot{}, false
		}
		return slot{object: container, key: last, captures: captures}, true
	}
	return slot{}, false
}

// pruneEmptyAncestors removes objects a move emptied.
func pruneEmptyAncestors(root any, segments []string, captures []capture) {
	for depth := len(segments) - 1; depth >= 1; depth-- {
		s, ok := createSlot(root, segments[:depth], captures)
		if !ok {
			return
		}
		value, present := readSlot(s)
		object, isObject := value.(*Object)
		if !present || !isObject || object.Len() != 0 {
			return
		}
		deleteSlot(s)
	}
}
