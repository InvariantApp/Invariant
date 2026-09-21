// Package invariant runs compiled Invariant programs: the same interpreter as
// the TypeScript runtime, held to the same conformance vectors.
package invariant

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Object is a JSON object that keeps its keys in the order they were written
// or added, as the reference runtime does. A caller reading a body sees the
// fields where they expect them, and a renamed field moves to the end.
type Object struct {
	keys   []string
	values map[string]any
}

// NewObject returns an empty object.
func NewObject() *Object { return &Object{values: map[string]any{}} }

// Get returns the value under key and whether it is present.
func (o *Object) Get(key string) (any, bool) {
	value, ok := o.values[key]
	return value, ok
}

// Set writes a value, adding the key at the end when it is new.
func (o *Object) Set(key string, value any) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// Delete removes a key.
func (o *Object) Delete(key string) {
	if _, ok := o.values[key]; !ok {
		return
	}
	delete(o.values, key)
	for index, each := range o.keys {
		if each == key {
			o.keys = append(o.keys[:index], o.keys[index+1:]...)
			break
		}
	}
}

// Keys returns the keys in order.
func (o *Object) Keys() []string { return o.keys }

// Len returns how many keys the object holds.
func (o *Object) Len() int { return len(o.keys) }

// Array is a JSON list, held by pointer so a write through a slot is seen by
// everything holding the list.
type Array struct{ Items []any }

// Number is a JSON number as decimal text, never as a float, so money that
// passes through is never rounded.
type Number string

// MaxDepth is how deeply a body may nest.
const MaxDepth = 256

// ErrTooDeep is returned for a body nested past MaxDepth.
var ErrTooDeep = fmt.Errorf("the body nests more than %d levels deep", MaxDepth)

// beyondDouble matches a number a double might not hold, which keeps its
// original digits rather than being read as a double.
var beyondDouble = regexp.MustCompile(`[\d.][eE][+-]?\d{3}|\d{100}`)

// Parse reads a JSON body. Numbers are read as the reference reads them: as a
// double, written back in its shortest exact form, unless the text holds more
// than a double can, in which case the digits are kept as they were written.
func Parse(text []byte) (any, error) {
	if tooDeep(text, MaxDepth) {
		return nil, ErrTooDeep
	}
	preserve := beyondDouble.Match(text)
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.UseNumber()
	value, err := parseValue(decoder, preserve)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("unexpected text after the JSON value")
	}
	return value, nil
}

func tooDeep(text []byte, limit int) bool {
	if len(text) <= limit {
		return false
	}
	depth := 0
	inString := false
	for index := 0; index < len(text); index++ {
		c := text[index]
		if inString {
			if c == '\\' {
				index++
			} else if c == '"' {
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '[', '{':
			depth++
			if depth > limit {
				return true
			}
		case ']', '}':
			depth--
		}
	}
	return false
}

func parseValue(decoder *json.Decoder, preserve bool) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			object := NewObject()
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("object key is not a string")
				}
				child, err := parseValue(decoder, preserve)
				if err != nil {
					return nil, err
				}
				object.Set(key, child)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return object, nil
		case '[':
			array := &Array{Items: []any{}}
			for decoder.More() {
				child, err := parseValue(decoder, preserve)
				if err != nil {
					return nil, err
				}
				array.Items = append(array.Items, child)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return array, nil
		}
		return nil, fmt.Errorf("unexpected %v", value)
	case json.Number:
		if preserve {
			return Number(value.String()), nil
		}
		return numberFromDouble(value.String())
	case string, bool, nil:
		return value, nil
	}
	return nil, fmt.Errorf("unexpected token %v", token)
}

// numberFromDouble reads a number as a double and writes it as JavaScript
// would, which is the shortest text that reads back as the same double.
func numberFromDouble(text string) (any, error) {
	f, err := strconv.ParseFloat(text, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return nil, err
	}
	if math.IsInf(f, 0) || math.IsNaN(f) {
		return nil, fmt.Errorf("%s is not a finite number", text)
	}
	return Number(jsNumberText(f)), nil
}

// jsNumberText is ECMAScript's Number::toString: the shortest digits that
// read back as the same double, in plain notation between 1e-7 and 1e21 and
// exponential outside it.
func jsNumberText(f float64) string {
	if f == 0 {
		return "0"
	}
	negative := f < 0
	if negative {
		f = -f
	}
	// Shortest round-trip digits and the decimal exponent, as d.ddde±x.
	scientific := strconv.FormatFloat(f, 'e', -1, 64)
	mantissa, exponentText, _ := strings.Cut(scientific, "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	exponent, _ := strconv.Atoi(exponentText)
	k := len(digits)
	n := exponent + 1 // the position of the decimal point after the first digit
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		sign := "+"
		if n-1 < 0 {
			sign = "-"
		}
		power := n - 1
		if power < 0 {
			power = -power
		}
		if k == 1 {
			out = digits + "e" + sign + strconv.Itoa(power)
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(power)
		}
	}
	if negative {
		return "-" + out
	}
	return out
}

// Marshal writes a value as JSON, keys in their order and numbers as their
// text.
func Marshal(value any) ([]byte, error) {
	var buffer bytes.Buffer
	if err := write(&buffer, value); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func write(buffer *bytes.Buffer, value any) error {
	switch v := value.(type) {
	case nil:
		buffer.WriteString("null")
	case bool:
		if v {
			buffer.WriteString("true")
		} else {
			buffer.WriteString("false")
		}
	case Number:
		buffer.WriteString(string(v))
	case string:
		encoded, err := json.Marshal(v)
		if err != nil {
			return err
		}
		buffer.Write(encoded)
	case *Array:
		buffer.WriteByte('[')
		for index, item := range v.Items {
			if index > 0 {
				buffer.WriteByte(',')
			}
			if err := write(buffer, item); err != nil {
				return err
			}
		}
		buffer.WriteByte(']')
	case *Object:
		buffer.WriteByte('{')
		for index, key := range v.keys {
			if index > 0 {
				buffer.WriteByte(',')
			}
			encoded, err := json.Marshal(key)
			if err != nil {
				return err
			}
			buffer.Write(encoded)
			buffer.WriteByte(':')
			if err := write(buffer, v.values[key]); err != nil {
				return err
			}
		}
		buffer.WriteByte('}')
	default:
		return fmt.Errorf("cannot write %T as JSON", value)
	}
	return nil
}

// Clone copies a value deeply, so a value a program writes in several places
// is never shared between them.
func Clone(value any) any {
	switch v := value.(type) {
	case *Object:
		out := NewObject()
		for _, key := range v.keys {
			out.Set(key, Clone(v.values[key]))
		}
		return out
	case *Array:
		items := make([]any, len(v.Items))
		for index, item := range v.Items {
			items[index] = Clone(item)
		}
		return &Array{Items: items}
	default:
		return v
	}
}
