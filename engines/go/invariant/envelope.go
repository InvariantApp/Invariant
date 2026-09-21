package invariant

// A request as one tree, and back.
//
// Open reads the parameters a program names out of the request, decoded into
// typed values the way their declaration says they are written, and places
// them beside the body under @path, @query, @header and @cookie. The
// interpreter then runs over that tree like any body. Close writes what the
// tree holds back into the request, encoded the way the current contract
// declares each parameter.
//
// Only named parameters are ever decoded or rewritten. Everything else in the
// request, including the order of an untouched query string, is passed on
// exactly as it arrived.

import (
	"net/url"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

// ParamCodec says how one parameter is written.
type ParamCodec struct {
	In      string
	Name    string
	Style   string
	Explode bool
	Type    string
	// Items is the scalar type of each item of a list, or "".
	Items string
}

// Envelope is a site's program over the whole request.
type Envelope struct {
	Instrs []*Instr
	// Old says how an old caller writes each named parameter, keyed "in name".
	Old map[string]*ParamCodec
	// OldOrder is Old's keys in declaration order, which is decoding order.
	OldOrder []string
	// New says how the current contract expects each one, keyed the same way.
	New      map[string]*ParamCodec
	NewOrder []string
	Body     bool
}

// EnvelopeRequest is a request as a binding hands it over and gets it back.
type EnvelopeRequest struct {
	// Path is the routed path as the contract writes it, without a base path.
	Path string
	// Search is the raw query string, without its "?".
	Search string
	// Headers are every header line, in the order received.
	Headers [][2]string
	// Body is the body text, or nil when there is none.
	Body *string
	// Form is true when the body is form-encoded rather than JSON.
	Form bool
}

var parts = map[string]string{
	"path":   "@path",
	"query":  "@query",
	"header": "@header",
	"cookie": "@cookie",
}

var locationOfPart = map[string]string{
	"@path":   "path",
	"@query":  "query",
	"@header": "header",
	"@cookie": "cookie",
}

func codecKey(location, name string) string {
	if location == "header" {
		name = strings.ToLower(name)
	}
	return location + " " + name
}

var jsonNumber = regexp.MustCompile(`^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$`)

type queryPair struct{ raw, key, value string }

// decodeComponent is JavaScript's decodeURIComponent after `+` became a
// space: text that is not valid percent-encoding, or not UTF-8 once decoded,
// is compared as written, so it only ever matches a parameter literally named
// that, and it is passed on untouched.
func decodeComponent(text string) string {
	return decodeSegment(strings.ReplaceAll(text, "+", " "))
}

// decodeSegment is a path segment percent-decoded, where `+` is a plus sign.
func decodeSegment(text string) string {
	decoded, err := url.PathUnescape(text)
	if err != nil || !utf8.ValidString(decoded) {
		return text
	}
	return decoded
}

// encodeURIComponent escapes as JavaScript's encodeURIComponent does.
func encodeURIComponent(text string) string {
	var out strings.Builder
	for index := 0; index < len(text); index++ {
		c := text[index]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			strings.IndexByte("-_.!~*'()", c) >= 0 {
			out.WriteByte(c)
			continue
		}
		out.WriteByte('%')
		out.WriteByte("0123456789ABCDEF"[c>>4])
		out.WriteByte("0123456789ABCDEF"[c&15])
	}
	return out.String()
}

func queryPairs(search string) []queryPair {
	if search == "" {
		return nil
	}
	var pairs []queryPair
	for _, raw := range strings.Split(search, "&") {
		equals := strings.IndexByte(raw, '=')
		if equals == -1 {
			pairs = append(pairs, queryPair{raw: raw, key: decodeComponent(raw)})
			continue
		}
		pairs = append(pairs, queryPair{
			raw:   raw,
			key:   decodeComponent(raw[:equals]),
			value: decodeComponent(raw[equals+1:]),
		})
	}
	return pairs
}

func cookiePairs(headers [][2]string) [][2]string {
	var pairs [][2]string
	for _, header := range headers {
		if strings.ToLower(header[0]) != "cookie" {
			continue
		}
		for _, part := range strings.Split(header[1], ";") {
			trimmed := strings.TrimSpace(part)
			if trimmed == "" {
				continue
			}
			equals := strings.IndexByte(trimmed, '=')
			if equals == -1 {
				pairs = append(pairs, [2]string{trimmed, ""})
			} else {
				pairs = append(pairs, [2]string{trimmed[:equals], trimmed[equals+1:]})
			}
		}
	}
	return pairs
}

// scalar is text typed the way its declaration says it is. Anything else
// stays text: an instruction that needs a number refuses it then, with the
// Change that asked, and one that does not passes it through.
func scalar(text, kind string) any {
	if (kind == "integer" || kind == "number") && jsonNumber.MatchString(text) {
		if value, err := Parse([]byte(text)); err == nil {
			return value
		}
	}
	if kind == "boolean" && (text == "true" || text == "false") {
		return text == "true"
	}
	return text
}

func delimiterOf(codec *ParamCodec) string {
	switch codec.Style {
	case "spaceDelimited":
		return " "
	case "pipeDelimited":
		return "|"
	}
	return ","
}

// decodeValue is a value from its written parts: every occurrence for an
// exploded list.
func decodeValue(written []string, codec *ParamCodec) any {
	first := ""
	if len(written) > 0 {
		first = written[0]
	}
	switch codec.Type {
	case "array":
		item := codec.Items
		if item == "" {
			item = "string"
		}
		values := written
		if !codec.Explode || codec.In == "header" || codec.In == "path" {
			values = strings.Split(first, delimiterOf(codec))
			if codec.In == "header" {
				for index, entry := range values {
					values[index] = strings.TrimSpace(entry)
				}
			}
		}
		out := &Array{Items: make([]any, len(values))}
		for index, entry := range values {
			out.Items[index] = scalar(entry, item)
		}
		return out
	case "object":
		object := NewObject()
		if codec.Explode {
			for _, entry := range strings.Split(first, ",") {
				equals := strings.IndexByte(entry, '=')
				if equals == -1 {
					continue
				}
				key := strings.TrimSpace(entry[:equals])
				if isUnsafeKey(key) {
					continue
				}
				object.Set(key, strings.TrimSpace(entry[equals+1:]))
			}
		} else {
			flat := strings.Split(first, ",")
			for index := 0; index+1 < len(flat); index += 2 {
				if !isUnsafeKey(flat[index]) {
					object.Set(flat[index], flat[index+1])
				}
			}
		}
		return object
	}
	return scalar(first, codec.Type)
}

var templateParameter = regexp.MustCompile(`\{([^{}]+)\}`)

// templateNames are the template's parameter names, in the order
// matchTemplate returns values.
func templateNames(template []string) []string {
	var names []string
	for _, segment := range template {
		for _, match := range templateParameter.FindAllStringSubmatch(segment, -1) {
			names = append(names, match[1])
		}
	}
	return names
}

func isWholeParameter(segment string) bool {
	return strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") &&
		strings.IndexByte(segment, '}') == len(segment)-1
}

var mixedSegments sync.Map

// mixedSegment is the pattern for a segment that mixes literal text and
// parameters, such as `{name}:batchGet`, compiled once per template segment.
func mixedSegment(template string) *regexp.Regexp {
	if compiled, ok := mixedSegments.Load(template); ok {
		return compiled.(*regexp.Regexp)
	}
	literals := templateParameter.Split(template, -1)
	for index, literal := range literals {
		literals[index] = regexp.QuoteMeta(literal)
	}
	compiled := regexp.MustCompile(`(?s)^` + strings.Join(literals, "(.+)") + `$`)
	mixedSegments.Store(template, compiled)
	return compiled
}

// matchTemplate matches a concrete request path against a route template.
func matchTemplate(template []string, path string) ([]string, bool) {
	actual := strings.Split(path, "/")
	if len(actual) != len(template) {
		return nil, false
	}
	var params []string
	for index, expected := range template {
		segment := actual[index]
		if isWholeParameter(expected) {
			if segment == "" {
				return nil, false
			}
			params = append(params, segment)
			continue
		}
		if strings.Contains(expected, "{") {
			matched := mixedSegment(expected).FindStringSubmatch(segment)
			if matched == nil {
				return nil, false
			}
			params = append(params, matched[1:]...)
			continue
		}
		if expected != segment {
			return nil, false
		}
	}
	return params, true
}

func indexOf(values []string, wanted string) int {
	for index, value := range values {
		if value == wanted {
			return index
		}
	}
	return -1
}

// openEnvelope is the request as a tree holding only what the program names.
// pathValues are the values the routed path matched its template with.
func openEnvelope(envelope *Envelope, template, pathValues []string, request EnvelopeRequest) (*Object, error) {
	tree := NewObject()
	for _, location := range []string{"path", "query", "header", "cookie"} {
		tree.Set(parts[location], NewObject())
	}
	names := templateNames(template)
	query := queryPairs(request.Search)
	cookies := cookiePairs(request.Headers)

	for _, key := range envelope.OldOrder {
		codec := envelope.Old[key]
		var written []string
		var object *Object
		switch codec.In {
		case "path":
			if index := indexOf(names, codec.Name); index != -1 && index < len(pathValues) {
				written = []string{decodeSegment(pathValues[index])}
			}
		case "query":
			if codec.Style == "deepObject" {
				prefix := codec.Name + "["
				for _, pair := range query {
					if !strings.HasPrefix(pair.key, prefix) || !strings.HasSuffix(pair.key, "]") {
						continue
					}
					// A property name is the caller's to choose, including
					// __proto__, which must never reach an object as a key.
					name := pair.key[len(prefix) : len(pair.key)-1]
					if isUnsafeKey(name) {
						continue
					}
					if object == nil {
						object = NewObject()
					}
					object.Set(name, pair.value)
				}
			} else {
				for _, pair := range query {
					if pair.key == codec.Name {
						written = append(written, pair.value)
					}
				}
			}
		case "header":
			var lines []string
			for _, header := range request.Headers {
				if strings.ToLower(header[0]) == codec.Name {
					lines = append(lines, strings.TrimSpace(header[1]))
				}
			}
			// Several lines of one header are one comma-separated value.
			if len(lines) > 0 {
				written = []string{strings.Join(lines, ", ")}
			}
		case "cookie":
			for _, cookie := range cookies {
				if cookie[0] == codec.Name {
					written = append(written, cookie[1])
				}
			}
		}
		part, _ := tree.Get(parts[codec.In])
		if object != nil {
			part.(*Object).Set(codec.Name, object)
		} else if len(written) > 0 {
			part.(*Object).Set(codec.Name, decodeValue(written, codec))
		}
	}

	if envelope.Body && request.Body != nil && *request.Body != "" {
		body, err := parseBody([]byte(*request.Body))
		if err != nil {
			return nil, err
		}
		tree.Set("@body", body)
	}
	return tree, nil
}

func textOf(value any, changeID, where string) (string, error) {
	switch v := value.(type) {
	case string:
		return v, nil
	case bool:
		if v {
			return "true", nil
		}
		return "false", nil
	case nil:
		return "", nil
	case Number:
		return string(v), nil
	}
	return "", &TransformError{ChangeID: changeID, Message: where + " holds a value that cannot be written as text", Kind: "transform"}
}

// encodeValue is the written parts of a value: one per occurrence for an
// exploded list.
func encodeValue(value any, codec *ParamCodec, changeID string) ([]string, error) {
	where := codec.In + " parameter " + codec.Name
	switch v := value.(type) {
	case *Array:
		items := make([]string, len(v.Items))
		for index, entry := range v.Items {
			text, err := textOf(entry, changeID, where)
			if err != nil {
				return nil, err
			}
			items[index] = text
		}
		if codec.Explode && (codec.In == "query" || codec.In == "cookie") {
			return items, nil
		}
		return []string{strings.Join(items, delimiterOf(codec))}, nil
	case *Object:
		entries := make([]string, 0, 2*v.Len())
		for _, key := range v.Keys() {
			entry, _ := v.Get(key)
			text, err := textOf(entry, changeID, where)
			if err != nil {
				return nil, err
			}
			if codec.Explode {
				entries = append(entries, key+"="+text)
			} else {
				entries = append(entries, key, text)
			}
		}
		return []string{strings.Join(entries, ",")}, nil
	}
	text, err := textOf(value, changeID, where)
	if err != nil {
		return nil, err
	}
	return []string{text}, nil
}

var fallbackStyles = map[string]ParamCodec{
	"path":   {Style: "simple", Explode: false},
	"query":  {Style: "form", Explode: true},
	"header": {Style: "simple", Explode: false},
	"cookie": {Style: "form", Explode: true},
}

// TouchedPaths are every place an instruction reads or writes, as segments
// from the root it runs at.
func TouchedPaths(instr *Instr) [][]string { return touchedPaths(instr, nil) }

// touchedPaths are every place an instruction reads or writes, as segments
// from the root it runs at.
func touchedPaths(instr *Instr, entered map[string]bool) [][]string {
	inner := func(block []*Instr) [][]string {
		var out [][]string
		for _, each := range block {
			out = append(out, touchedPaths(each, entered)...)
		}
		return out
	}
	switch instr.K {
	case "move":
		return [][]string{instr.From, instr.To}
	case "within":
		out := [][]string{instr.Path}
		for _, path := range inner(instr.Block) {
			out = append(out, append(append([]string{}, instr.Path...), path...))
		}
		return out
	case "switch":
		out := [][]string{instr.Path}
		for _, block := range instr.Cases {
			out = append(out, inner(block)...)
		}
		return out
	case "has", "is":
		return append([][]string{instr.Path}, inner(instr.Block)...)
	case "call":
		if entered[instr.Name] {
			return nil
		}
		deeper := map[string]bool{instr.Name: true}
		for name := range entered {
			deeper[name] = true
		}
		var out [][]string
		for _, each := range instr.Target.Instrs {
			out = append(out, touchedPaths(each, deeper)...)
		}
		return out
	}
	return [][]string{instr.Path}
}

// writerOf is the change that last wrote under a pointer prefix, for naming
// a refusal.
func writerOf(instrs []*Instr, part, name string) string {
	for index := len(instrs) - 1; index >= 0; index-- {
		for _, path := range touchedPaths(instrs[index], nil) {
			if len(path) >= 2 && path[0] == part && path[1] == name {
				return instrs[index].C
			}
		}
	}
	if len(instrs) > 0 {
		return instrs[0].C
	}
	return ""
}

// Characters that would end a header line or a cookie early.
var (
	unsafeHeader = regexp.MustCompile(`[\r\n\x00]`)
	unsafeCookie = regexp.MustCompile(`[\r\n\x00;,\s]`)
)

// closeEnvelope writes the tree back into a request. A parameter the program
// named is taken out of the request wherever it was and written again from
// the tree, so one it moved away is gone and one it moved in arrives in the
// current contract's own style.
func closeEnvelope(envelope *Envelope, template, pathValues []string, request EnvelopeRequest, tree *Object) (EnvelopeRequest, error) {
	named := map[string]map[string]bool{}
	var namedOrder []*ParamCodec
	for _, key := range envelope.OldOrder {
		namedOrder = append(namedOrder, envelope.Old[key])
	}
	for _, key := range envelope.NewOrder {
		namedOrder = append(namedOrder, envelope.New[key])
	}
	for _, codec := range namedOrder {
		if named[codec.In] == nil {
			named[codec.In] = map[string]bool{}
		}
		named[codec.In][codec.Name] = true
	}
	codecFor := func(location, name string) *ParamCodec {
		if codec, ok := envelope.New[codecKey(location, name)]; ok {
			return codec
		}
		if codec, ok := envelope.Old[codecKey(location, name)]; ok {
			return codec
		}
		fallback := fallbackStyles[location]
		return &ParamCodec{In: location, Name: name, Type: "string", Style: fallback.Style, Explode: fallback.Explode}
	}
	partOf := func(location string) *Object {
		if part, ok := tree.Get(parts[location]); ok {
			if object, ok := part.(*Object); ok {
				return object
			}
		}
		return NewObject()
	}
	out := EnvelopeRequest{Path: request.Path, Search: request.Search, Headers: request.Headers, Body: request.Body}

	// Path: every parameter of the template has to have a value afterwards.
	if len(named["path"]) > 0 {
		names := templateNames(template)
		values := partOf("path")
		filled := make([]string, len(names))
		for index, name := range names {
			if !named["path"][name] {
				if index < len(pathValues) {
					filled[index] = pathValues[index]
				}
				continue
			}
			value, present := values.Get(name)
			changeID := writerOf(envelope.Instrs, "@path", name)
			if !present || value == nil {
				return out, &TransformError{ChangeID: changeID, Message: "path parameter " + name + " was left without a value", Kind: "transform"}
			}
			written, err := encodeValue(value, codecFor("path", name), changeID)
			if err != nil {
				return out, err
			}
			filled[index] = encodeURIComponent(written[0])
		}
		next := 0
		segments := make([]string, len(template))
		for index, segment := range template {
			segments[index] = templateParameter.ReplaceAllStringFunc(segment, func(string) string {
				value := ""
				if next < len(filled) {
					value = filled[next]
				}
				next++
				return value
			})
		}
		out.Path = strings.Join(segments, "/")
	}

	// Query: untouched pairs keep their bytes and their order.
	if queryNamed := named["query"]; len(queryNamed) > 0 {
		var written []string
		for _, pair := range queryPairs(request.Search) {
			if queryNamed[pair.key] {
				continue
			}
			bracketed := false
			for name := range queryNamed {
				if strings.HasPrefix(pair.key, name+"[") && strings.HasSuffix(pair.key, "]") {
					bracketed = true
					break
				}
			}
			if !bracketed {
				written = append(written, pair.raw)
			}
		}
		query := partOf("query")
		for _, name := range query.Keys() {
			value, _ := query.Get(name)
			codec := codecFor("query", name)
			changeID := writerOf(envelope.Instrs, "@query", name)
			if object, ok := value.(*Object); ok && codec.Style == "deepObject" {
				for _, key := range object.Keys() {
					entry, _ := object.Get(key)
					text, err := textOf(entry, changeID, "query parameter "+name)
					if err != nil {
						return out, err
					}
					written = append(written, encodeURIComponent(name)+"["+encodeURIComponent(key)+"]="+encodeURIComponent(text))
				}
				continue
			}
			values, err := encodeValue(value, codec, changeID)
			if err != nil {
				return out, err
			}
			for _, part := range values {
				encoded := encodeURIComponent(part)
				if !codec.Explode {
					separator := delimiterOf(codec)
					pieces := strings.Split(part, separator)
					for index, piece := range pieces {
						pieces[index] = encodeURIComponent(piece)
					}
					if separator == " " {
						separator = "%20"
					}
					encoded = strings.Join(pieces, separator)
				}
				written = append(written, encodeURIComponent(name)+"="+encoded)
			}
		}
		out.Search = strings.Join(written, "&")
	}

	// Headers: a named one is removed in every casing and written once.
	headerNamed, cookieNamed := named["header"], named["cookie"]
	if len(headerNamed) > 0 || len(cookieNamed) > 0 {
		var headers [][2]string
		for _, header := range request.Headers {
			lower := strings.ToLower(header[0])
			if headerNamed[lower] || (len(cookieNamed) > 0 && lower == "cookie") {
				continue
			}
			headers = append(headers, header)
		}
		header := partOf("header")
		for _, name := range header.Keys() {
			value, _ := header.Get(name)
			changeID := writerOf(envelope.Instrs, "@header", name)
			written, err := encodeValue(value, codecFor("header", name), changeID)
			if err != nil {
				return out, err
			}
			if unsafeHeader.MatchString(written[0]) {
				return out, &TransformError{ChangeID: changeID, Message: "header " + name + " would carry a line break", Kind: "transform"}
			}
			headers = append(headers, [2]string{strings.ToLower(name), written[0]})
		}
		if len(cookieNamed) > 0 {
			var all []string
			for _, cookie := range cookiePairs(request.Headers) {
				if !cookieNamed[cookie[0]] {
					all = append(all, cookie[0]+"="+cookie[1])
				}
			}
			cookies := partOf("cookie")
			for _, name := range cookies.Keys() {
				value, _ := cookies.Get(name)
				changeID := writerOf(envelope.Instrs, "@cookie", name)
				written, err := encodeValue(value, codecFor("cookie", name), changeID)
				if err != nil {
					return out, err
				}
				for _, part := range written {
					if unsafeCookie.MatchString(part) {
						return out, &TransformError{ChangeID: changeID, Message: "cookie " + name + " would carry a separator", Kind: "transform"}
					}
					all = append(all, name+"="+part)
				}
			}
			if len(all) > 0 {
				headers = append(headers, [2]string{"cookie", strings.Join(all, "; ")})
			}
		}
		out.Headers = headers
	}

	if body, present := tree.Get("@body"); envelope.Body && present {
		text, err := Marshal(body)
		if err != nil {
			return out, err
		}
		written := string(text)
		out.Body = &written
	} else if envelope.Body && request.Body != nil && *request.Body != "" {
		// A body an instruction took away entirely is sent empty, never as it came.
		empty := ""
		out.Body = &empty
	}
	return out, nil
}

// Styles each location can be written in.
var paramStyles = map[string][]string{
	"path":   {"simple"},
	"query":  {"form", "spaceDelimited", "pipeDelimited", "deepObject"},
	"header": {"simple"},
	"cookie": {"form"},
}

var paramTypes = map[string]bool{"string": true, "integer": true, "number": true, "boolean": true, "array": true, "object": true}

// deniedHeaders are the headers no program may touch, the same list the
// compiler and the reference runtime hold.
var deniedHeaders = map[string]bool{
	"authorization": true, "proxy-authorization": true, "cookie": true, "set-cookie": true,
	"host": true, "connection": true, "keep-alive": true, "proxy-connection": true, "te": true,
	"trailer": true, "transfer-encoding": true, "upgrade": true, "expect": true,
	"content-length": true, "content-type": true, "content-encoding": true,
	"x-api-key": true, "api-key": true, "x-auth-token": true,
}

var deniedWords = regexp.MustCompile(`signature|hmac|digest|credential|secret`)

func decodeCodec(raw any, where string) (*ParamCodec, error) {
	value, err := asObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := expectKeys(value, []string{"in", "name", "style", "explode", "type", "items"}, where); err != nil {
		return nil, err
	}
	codec := &ParamCodec{}
	if codec.In, err = stringField(value, "in", where); err != nil {
		return nil, err
	}
	styles, known := paramStyles[codec.In]
	if !known {
		return nil, programError("%s.in is not a parameter location", where)
	}
	if codec.Name, err = stringField(value, "name", where); err != nil {
		return nil, err
	}
	if codec.Name == "" || isUnsafeKey(codec.Name) {
		return nil, programError("%s.name may not be %q", where, codec.Name)
	}
	if codec.In == "header" {
		if codec.Name != strings.ToLower(codec.Name) {
			return nil, programError("%s.name must be lowercase for a header", where)
		}
		if deniedHeaders[codec.Name] || deniedWords.MatchString(codec.Name) {
			return nil, programError("%s names the %s header, which no program may touch", where, codec.Name)
		}
	}
	if codec.Style, err = stringField(value, "style", where); err != nil {
		return nil, err
	}
	if indexOf(styles, codec.Style) == -1 {
		return nil, programError("%s.style %s is not served for a %s parameter", where, codec.Style, codec.In)
	}
	explode, ok := field(value, "explode").(bool)
	if !ok {
		return nil, programError("%s.explode must be a boolean", where)
	}
	codec.Explode = explode
	if codec.Type, err = stringField(value, "type", where); err != nil {
		return nil, err
	}
	if !paramTypes[codec.Type] {
		return nil, programError("%s.type is not a parameter type", where)
	}
	if codec.Type == "object" && explode && codec.Style == "form" {
		return nil, programError("%s is an exploded form object, which is not served", where)
	}
	if codec.Style == "deepObject" && codec.Type != "object" {
		return nil, programError("%s is a deepObject that is not an object", where)
	}
	if items, present := value.Get("items"); present {
		text, isText := items.(string)
		if codec.Type != "array" || !isText || !scalars[text] {
			return nil, programError("%s.items must be a scalar type, on an array", where)
		}
		codec.Items = text
	}
	return codec, nil
}

// pathConversions are the only instructions that may reach a path parameter:
// a template has exactly the parameters it has, so one can be converted but
// not moved, added or taken away.
var pathConversions = map[string]bool{"scale": true, "enum": true, "cast": true, "time": true, "case": true}

func decodeEnvelope(raw any, where string, named blocks) (*Envelope, error) {
	value, err := asObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := expectKeys(value, []string{"instrs", "params", "body"}, where); err != nil {
		return nil, err
	}
	list, err := asArray(field(value, "instrs"), where+".instrs")
	if err != nil {
		return nil, err
	}
	envelope := &Envelope{Old: map[string]*ParamCodec{}, New: map[string]*ParamCodec{}}
	for index, entry := range list {
		instr, err := decodeInstr(entry, where+".instrs["+itoa(index)+"]", 0, named, false)
		if err != nil {
			return nil, err
		}
		envelope.Instrs = append(envelope.Instrs, instr)
	}
	params, err := asObject(field(value, "params"), where+".params")
	if err != nil {
		return nil, err
	}
	if err := expectKeys(params, []string{"old", "new"}, where+".params"); err != nil {
		return nil, err
	}
	for _, side := range []string{"old", "new"} {
		entries, err := asArray(field(params, side), where+".params."+side)
		if err != nil {
			return nil, err
		}
		codecs, order := envelope.Old, &envelope.OldOrder
		if side == "new" {
			codecs, order = envelope.New, &envelope.NewOrder
		}
		for index, entry := range entries {
			codec, err := decodeCodec(entry, where+".params."+side+"["+itoa(index)+"]")
			if err != nil {
				return nil, err
			}
			key := codecKey(codec.In, codec.Name)
			if _, seen := codecs[key]; !seen {
				*order = append(*order, key)
			}
			codecs[key] = codec
		}
	}
	body, ok := field(value, "body").(bool)
	if !ok {
		return nil, programError("%s.body must be a boolean", where)
	}
	envelope.Body = body

	// Every place an instruction reaches is a part of the request and, outside
	// the body, one named parameter the program says how to write.
	for index, instr := range envelope.Instrs {
		at := where + ".instrs[" + itoa(index) + "]"
		for _, path := range touchedPaths(instr, nil) {
			if len(path) > 0 && path[0] == "@body" {
				if !body {
					return nil, programError("%s reaches the body, which body says is not read", at)
				}
				continue
			}
			location := ""
			if len(path) > 0 {
				location = locationOfPart[path[0]]
			}
			if location == "" || len(path) < 2 || path[1] == "*" {
				return nil, programError("%s must address one named parameter or the body", at)
			}
			key := codecKey(location, path[1])
			_, old := envelope.Old[key]
			_, next := envelope.New[key]
			if !old && !next {
				return nil, programError("%s names the %s parameter %s, which params does not declare", at, location, path[1])
			}
			if location == "path" && !pathConversions[instr.K] {
				return nil, programError("%s can only convert a path parameter", at)
			}
		}
	}
	return envelope, nil
}

// runEnvelope rewrites a whole request through a site's envelope.
func runEnvelope(site *Site, request EnvelopeRequest, limits Limits) (EnvelopeRequest, *Result, error) {
	envelope, template := site.Envelope, site.Template
	if envelope == nil || len(envelope.Instrs) == 0 {
		return request, &Result{Applied: map[string]int{}, Folded: map[string]bool{}}, nil
	}
	values, _ := matchTemplate(template, request.Path)
	if !request.Form || !envelope.Body || site.Form == nil {
		tree, err := openEnvelope(envelope, template, values, request)
		if err != nil {
			return request, nil, err
		}
		result, err := Execute(tree, envelope.Instrs, limits)
		if err != nil {
			return request, nil, err
		}
		out, err := closeEnvelope(envelope, template, values, request, tree)
		if err != nil {
			return request, nil, err
		}
		return out, result, nil
	}

	// A form body is decoded and written back by the form rules; the rest of
	// the envelope is what it always is.
	parameters := *envelope
	parameters.Body = false
	roots := formRoots(envelope.Instrs, 1)
	text := ""
	if request.Body != nil {
		text = *request.Body
	}
	tree, err := openEnvelope(&parameters, template, values, request)
	if err != nil {
		return request, nil, err
	}
	body, err := openForm(site.Form, roots, text)
	if err != nil {
		return request, nil, err
	}
	tree.Set("@body", body)
	result, err := Execute(tree, envelope.Instrs, limits)
	if err != nil {
		return request, nil, err
	}
	out, err := closeEnvelope(&parameters, template, values, request, tree)
	if err != nil {
		return request, nil, err
	}
	written, _ := tree.Get("@body")
	object, isObject := written.(*Object)
	if !isObject {
		object = NewObject()
	}
	form, err := closeForm(site.Form, roots, text, object, envelope.Instrs, 1)
	if err != nil {
		return request, nil, err
	}
	out.Body = &form
	return out, result, nil
}
