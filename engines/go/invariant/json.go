// Package invariant runs compiled Invariant programs: the same interpreter as
// the TypeScript runtime, held to the same conformance vectors.
package invariant

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Object is a JSON object that keeps its keys in the order the reference
// runtime does, which is JavaScript's: keys that are array indexes first, in
// ascending order, then every other key in the order it was written or added.
// A caller reading a body sees the fields where they expect them, a renamed
// field moves to the end, and `{"b":1,"2":2}` comes out as `{"2":2,"b":1}`
// from either engine.
type Object struct {
	keys   []string
	values map[string]any
}

// NewObject returns an empty object.
func NewObject() *Object {
	// Most objects in a body are small; starting with room for a few keys
	// saves growing the map and the order from nothing on every one.
	return &Object{values: make(map[string]any, 8), keys: make([]string, 0, 8)}
}

// Get returns the value under key and whether it is present.
func (o *Object) Get(key string) (any, bool) {
	value, ok := o.values[key]
	return value, ok
}

// Set writes a value. A new key goes at the end, or among the index keys in
// its numeric place when it is one.
func (o *Object) Set(key string, value any) {
	if _, ok := o.values[key]; !ok {
		index, isIndex := arrayIndex(key)
		at := len(o.keys)
		if isIndex {
			at = 0
			for at < len(o.keys) {
				other, otherIsIndex := arrayIndex(o.keys[at])
				if !otherIsIndex || other > index {
					break
				}
				at++
			}
		}
		o.keys = append(o.keys, "")
		copy(o.keys[at+1:], o.keys[at:])
		o.keys[at] = key
	}
	o.values[key] = value
}

// arrayIndex reads a key JavaScript treats as an array index: the canonical
// decimal text of an integer below 2^32 - 1.
func arrayIndex(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	var n uint64
	for index := 0; index < len(key); index++ {
		c := key[index]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + uint64(c-'0')
	}
	return n, n < 4294967295
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

// beyondDouble says whether the text holds a number a double might not: an
// exponent of three digits or more, or a hundred digits in a row. Such a body
// keeps its numbers' original digits rather than reading them as doubles. It
// means what the reference's /[\d.][eE][+-]?\d{3}|\d{100}/ means, scanned by
// hand because Go's regular expressions take most of a parse to run it.
func beyondDouble(text []byte) bool {
	digit := func(c byte) bool { return c >= '0' && c <= '9' }
	run := 0
	for index := 0; index < len(text); index++ {
		c := text[index]
		if digit(c) {
			run++
			if run >= 100 {
				return true
			}
			continue
		}
		run = 0
		if (c == 'e' || c == 'E') && index > 0 && (digit(text[index-1]) || text[index-1] == '.') {
			at := index + 1
			if at < len(text) && (text[at] == '+' || text[at] == '-') {
				at++
			}
			if at+2 < len(text) && digit(text[at]) && digit(text[at+1]) && digit(text[at+2]) {
				return true
			}
		}
	}
	return false
}

// Parse reads a JSON body. Numbers are read as the reference reads them: as a
// double, written back in its shortest exact form, unless the text holds more
// than a double can, in which case the digits are kept as they were written.
func Parse(text []byte) (any, error) {
	if tooDeep(text, MaxDepth) {
		return nil, ErrTooDeep
	}
	p := &parser{text: text, preserve: beyondDouble(text)}
	p.space()
	value, err := p.value()
	if err != nil {
		return nil, err
	}
	p.space()
	if p.at != len(p.text) {
		return nil, p.fail("unexpected text after the JSON value")
	}
	return value, nil
}

// parser reads JSON the way JSON.parse does, into Objects, Arrays, Numbers
// and strings: a duplicate key keeps its first place and its last value, and
// text that is not UTF-8, or an escape that is half a surrogate pair, reads
// as U+FFFD, which is what the reference sees after decoding the bytes.
type parser struct {
	text     []byte
	at       int
	preserve bool
}

func (p *parser) fail(message string) error {
	return fmt.Errorf("%s at byte %d", message, p.at)
}

func (p *parser) space() {
	for p.at < len(p.text) {
		switch p.text[p.at] {
		case ' ', '\t', '\n', '\r':
			p.at++
		default:
			return
		}
	}
}

func (p *parser) literal(word string, value any) (any, error) {
	if !bytes.HasPrefix(p.text[p.at:], []byte(word)) {
		return nil, p.fail("invalid literal")
	}
	p.at += len(word)
	return value, nil
}

func (p *parser) value() (any, error) {
	if p.at >= len(p.text) {
		return nil, p.fail("unexpected end of JSON")
	}
	switch c := p.text[p.at]; {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		return p.string()
	case c == 't':
		return p.literal("true", true)
	case c == 'f':
		return p.literal("false", false)
	case c == 'n':
		return p.literal("null", nil)
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	return nil, p.fail("unexpected character")
}

func (p *parser) object() (any, error) {
	p.at++ // {
	object := NewObject()
	p.space()
	if p.at < len(p.text) && p.text[p.at] == '}' {
		p.at++
		return object, nil
	}
	for {
		p.space()
		if p.at >= len(p.text) || p.text[p.at] != '"' {
			return nil, p.fail("object key is not a string")
		}
		key, err := p.string()
		if err != nil {
			return nil, err
		}
		p.space()
		if p.at >= len(p.text) || p.text[p.at] != ':' {
			return nil, p.fail("expected ':' after an object key")
		}
		p.at++
		p.space()
		child, err := p.value()
		if err != nil {
			return nil, err
		}
		object.Set(key.(string), child)
		p.space()
		if p.at >= len(p.text) {
			return nil, p.fail("unexpected end of JSON")
		}
		switch p.text[p.at] {
		case ',':
			p.at++
		case '}':
			p.at++
			return object, nil
		default:
			return nil, p.fail("expected ',' or '}'")
		}
	}
}

func (p *parser) array() (any, error) {
	p.at++ // [
	array := &Array{Items: []any{}}
	p.space()
	if p.at < len(p.text) && p.text[p.at] == ']' {
		p.at++
		return array, nil
	}
	for {
		p.space()
		child, err := p.value()
		if err != nil {
			return nil, err
		}
		array.Items = append(array.Items, child)
		p.space()
		if p.at >= len(p.text) {
			return nil, p.fail("unexpected end of JSON")
		}
		switch p.text[p.at] {
		case ',':
			p.at++
		case ']':
			p.at++
			return array, nil
		default:
			return nil, p.fail("expected ',' or ']'")
		}
	}
}

func hexValue(c byte) rune {
	switch {
	case c >= '0' && c <= '9':
		return rune(c - '0')
	case c >= 'a' && c <= 'f':
		return rune(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return rune(c-'A') + 10
	}
	return -1
}

// escape4 reads the four hex digits of a \u escape at p.at.
func (p *parser) escape4() (rune, error) {
	if p.at+4 > len(p.text) {
		return 0, p.fail("unfinished \\u escape")
	}
	var r rune
	for _, c := range p.text[p.at : p.at+4] {
		digit := hexValue(c)
		if digit < 0 {
			return 0, p.fail("invalid \\u escape")
		}
		r = r<<4 | digit
	}
	p.at += 4
	return r, nil
}

func (p *parser) string() (any, error) {
	p.at++ // "
	start := p.at
	// Most strings have no escapes and are already UTF-8: taken as they are.
	for p.at < len(p.text) {
		c := p.text[p.at]
		if c == '"' {
			raw := p.text[start:p.at]
			p.at++
			if utf8.Valid(raw) {
				return string(raw), nil
			}
			return strings.ToValidUTF8(string(raw), "\uFFFD"), nil
		}
		if c == '\\' || c < 0x20 {
			break
		}
		p.at++
	}
	var out strings.Builder
	out.Write(p.text[start:p.at])
	for {
		if p.at >= len(p.text) {
			return nil, p.fail("unterminated string")
		}
		c := p.text[p.at]
		switch {
		case c == '"':
			p.at++
			text := out.String()
			if !utf8.ValidString(text) {
				text = strings.ToValidUTF8(text, "\uFFFD")
			}
			return text, nil
		case c < 0x20:
			return nil, p.fail("control character in a string")
		case c != '\\':
			out.WriteByte(c)
			p.at++
			continue
		}
		p.at++ // backslash
		if p.at >= len(p.text) {
			return nil, p.fail("unterminated string")
		}
		escape := p.text[p.at]
		p.at++
		switch escape {
		case '"', '\\', '/':
			out.WriteByte(escape)
		case 'b':
			out.WriteByte('\b')
		case 'f':
			out.WriteByte('\f')
		case 'n':
			out.WriteByte('\n')
		case 'r':
			out.WriteByte('\r')
		case 't':
			out.WriteByte('\t')
		case 'u':
			r, err := p.escape4()
			if err != nil {
				return nil, err
			}
			if utf16.IsSurrogate(r) {
				low := rune(-1)
				if r < 0xDC00 && p.at+6 <= len(p.text) && p.text[p.at] == '\\' && p.text[p.at+1] == 'u' {
					saved := p.at
					p.at += 2
					if second, err := p.escape4(); err == nil && second >= 0xDC00 && second <= 0xDFFF {
						low = second
					} else {
						p.at = saved
					}
				}
				if low >= 0 {
					r = utf16.DecodeRune(r, low)
				} else {
					r = utf8.RuneError
				}
			}
			out.WriteRune(r)
		default:
			return nil, p.fail("invalid escape")
		}
	}
}

func (p *parser) number() (any, error) {
	start := p.at
	digit := func() bool { return p.at < len(p.text) && p.text[p.at] >= '0' && p.text[p.at] <= '9' }
	if p.text[p.at] == '-' {
		p.at++
	}
	switch {
	case p.at < len(p.text) && p.text[p.at] == '0':
		p.at++
	case digit():
		for digit() {
			p.at++
		}
	default:
		return nil, p.fail("invalid number")
	}
	if p.at < len(p.text) && p.text[p.at] == '.' {
		p.at++
		if !digit() {
			return nil, p.fail("invalid number")
		}
		for digit() {
			p.at++
		}
	}
	if p.at < len(p.text) && (p.text[p.at] == 'e' || p.text[p.at] == 'E') {
		p.at++
		if p.at < len(p.text) && (p.text[p.at] == '+' || p.text[p.at] == '-') {
			p.at++
		}
		if !digit() {
			return nil, p.fail("invalid number")
		}
		for digit() {
			p.at++
		}
	}
	text := string(p.text[start:p.at])
	if p.preserve {
		return Number(text), nil
	}
	return numberFromDouble(text)
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
		quote(buffer, v)
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
			quote(buffer, key)
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

// quote writes a string as JavaScript's JSON.stringify does, so a body is the
// same text from either engine: quotes, backslashes and control characters
// escaped, and everything else, <, > and & among it, written as it is.
func quote(buffer *bytes.Buffer, text string) {
	const hex = "0123456789abcdef"
	buffer.WriteByte('"')
	start := 0
	for index := 0; index < len(text); index++ {
		c := text[index]
		if c >= 0x20 && c != '"' && c != '\\' {
			continue
		}
		buffer.WriteString(text[start:index])
		switch c {
		case '"':
			buffer.WriteString(`\"`)
		case '\\':
			buffer.WriteString(`\\`)
		case '\b':
			buffer.WriteString(`\b`)
		case '\f':
			buffer.WriteString(`\f`)
		case '\n':
			buffer.WriteString(`\n`)
		case '\r':
			buffer.WriteString(`\r`)
		case '\t':
			buffer.WriteString(`\t`)
		default:
			buffer.WriteString(`\u00`)
			buffer.WriteByte(hex[c>>4])
			buffer.WriteByte(hex[c&15])
		}
		start = index + 1
	}
	buffer.WriteString(text[start:])
	buffer.WriteByte('"')
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
