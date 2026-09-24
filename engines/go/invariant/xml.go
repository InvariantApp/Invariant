package invariant

// XML bodies, as a tree and back.
//
// Amazon's CloudFront and CloudSearch, and every SOAP-era API described in
// OpenAPI, send and take text/xml. A program describes fields, not
// encodings, so the same instructions run whether a body arrived as JSON, as
// a form or as XML: the XML is decoded into a tree, the instructions run, and
// the tree is written back.
//
// Only the places the program names are decoded, as the site's description
// says they are written. Every element on the way that the description does
// not name is kept whole, bytes and all, and written back where it was, so a
// document the instructions leave as it was comes out byte for byte as it
// went in, and one they change differs only where they changed it.
//
// The parser is written for hostile input and by hand, to the same rules as
// the reference runtime's, rather than with encoding/xml, whose idea of a
// well-formed document is not quite XML's. A document type declaration is
// refused outright, so there are no entities beyond XML's five and character
// references, nothing external is ever fetched and nothing expands; nesting
// is capped as a JSON body's is. Anything this cannot write back exactly is
// refused rather than guessed at.

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// XMLNode is how one place in an XML body is written: see the IR's XmlNode.
type XMLNode struct {
	Type       string
	Name       string
	Namespace  string
	Prefix     string
	Attribute  bool
	Wrapped    bool
	Properties map[string]*XMLNode
	// propertyOrder is the order the properties were written in, which is
	// the order an element is matched against them.
	propertyOrder []string
	Items         *XMLNode
}

// XMLBody is one XML body: how the body the instructions read is written,
// and how the places they write are to be written.
type XMLBody struct {
	Read  *XMLNode
	Write *XMLNode
}

// XMLProgram is a site's XML bodies: the request's, and each status's.
type XMLProgram struct {
	Request  *XMLBody
	Response map[string]*XMLBody
}

const (
	xmlNamespace   = "http://www.w3.org/XML/1998/namespace"
	xmlnsNamespace = "http://www.w3.org/2000/xmlns/"
	keptPrefix     = "\x00"
)

func xmlError(format string, args ...any) error {
	return &SyntaxError{Message: "The body is not XML this operation can translate: " + fmt.Sprintf(format, args...)}
}

// ---------------------------------------------------------------------------
// Characters and names, as XML 1.0 (fifth edition) defines them.

func isXMLChar(r rune) bool {
	return r == 0x9 || r == 0xa || r == 0xd ||
		(r >= 0x20 && r <= 0xd7ff) ||
		(r >= 0xe000 && r <= 0xfffd) ||
		(r >= 0x10000 && r <= 0x10ffff)
}

func isNameStart(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_' || r == ':' ||
		(r >= 0xc0 && r <= 0xd6) || (r >= 0xd8 && r <= 0xf6) || (r >= 0xf8 && r <= 0x2ff) ||
		(r >= 0x370 && r <= 0x37d) || (r >= 0x37f && r <= 0x1fff) || (r >= 0x200c && r <= 0x200d) ||
		(r >= 0x2070 && r <= 0x218f) || (r >= 0x2c00 && r <= 0x2fef) || (r >= 0x3001 && r <= 0xd7ff) ||
		(r >= 0xf900 && r <= 0xfdcf) || (r >= 0xfdf0 && r <= 0xfffd) || (r >= 0x10000 && r <= 0xeffff)
}

func isNameChar(r rune) bool {
	return isNameStart(r) || r == '-' || r == '.' || (r >= '0' && r <= '9') || r == 0xb7 ||
		(r >= 0x300 && r <= 0x36f) || (r >= 0x203f && r <= 0x2040)
}

func isXMLSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

// isNCName says whether text is a name with no colon in it, as an element
// or attribute's local part is.
func isNCName(text string) bool {
	if text == "" {
		return false
	}
	first := true
	for _, r := range text {
		if r == ':' || r == utf8.RuneError || (first && !isNameStart(r)) || (!first && !isNameChar(r)) {
			return false
		}
		first = false
	}
	return true
}

// checkXMLChars refuses text holding a character XML does not allow, or
// that is not UTF-8 at all.
func checkXMLChars(text string) error {
	for index := 0; index < len(text); {
		r, size := utf8.DecodeRuneInString(text[index:])
		if r == utf8.RuneError && size <= 1 {
			return xmlError("bytes that are not UTF-8 at offset %d", index)
		}
		if !isXMLChar(r) {
			return xmlError("the character U+%04X at offset %d, which XML does not allow", r, index)
		}
		index += size
	}
	return nil
}

// ---------------------------------------------------------------------------
// Parsing.

// xmlDeclaration is the declaration this reads, the same pattern as the
// reference runtime's.
var xmlDeclaration = regexp.MustCompile(`^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"([A-Za-z][A-Za-z0-9._-]*)"|'([A-Za-z][A-Za-z0-9._-]*)'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>`)

var hexReference = regexp.MustCompile(`^#x[0-9A-Fa-f]{1,6}$`)
var decimalReference = regexp.MustCompile(`^#[0-9]{1,7}$`)

var namedReferences = map[string]string{"lt": "<", "gt": ">", "amp": "&", "apos": "'", "quot": `"`}

type xmlScope map[string]string

var rootScope = xmlScope{"xml": xmlNamespace}

type xmlAttribute struct {
	from, to  int
	qname     string
	prefix    string
	local     string
	namespace string
	value     string
	declares  bool
}

type xmlChild struct {
	element *xmlElement
	// kind is "element", "text" or "other".
	kind     string
	from, to int
	value    string
	blank    bool
}

type xmlElement struct {
	from, to   int
	startTo    int
	endFrom    int
	empty      bool
	qname      string
	prefix     string
	local      string
	namespace  string
	attributes []*xmlAttribute
	children   []*xmlChild
	inherited  xmlScope
	scope      xmlScope
}

type xmlDocument struct {
	text string
	root *xmlElement
}

// maxDeclarations is how many namespace declarations one document may
// make. Each element that declares one copies the namespaces in scope, so a
// document of thousands of declarations under hundreds of nested elements
// would cost their product. Real documents make a handful.
const maxDeclarations = 1024

type xmlParser struct {
	text         string
	at           int
	declarations int
}

func (p *xmlParser) fail(format string, args ...any) error {
	return &SyntaxError{Message: "The body is not XML this operation can translate: " + fmt.Sprintf(format, args...) + " at offset " + strconv.Itoa(p.at)}
}

func (p *xmlParser) startsWith(literal string) bool {
	return strings.HasPrefix(p.text[p.at:], literal)
}

func (p *xmlParser) spaces() {
	for p.at < len(p.text) && isXMLSpace(p.text[p.at]) {
		p.at++
	}
}

func (p *xmlParser) name() (string, error) {
	start := p.at
	r, size := utf8.DecodeRuneInString(p.text[p.at:])
	if size == 0 || !isNameStart(r) {
		return "", p.fail("expected a name")
	}
	p.at += size
	for p.at < len(p.text) {
		r, size = utf8.DecodeRuneInString(p.text[p.at:])
		if !isNameChar(r) {
			break
		}
		p.at += size
	}
	return p.text[start:p.at], nil
}

// reference is a `&...;` reference at the cursor, resolved.
func (p *xmlParser) reference() (string, error) {
	end := strings.IndexByte(p.text[p.at:], ';')
	if end == -1 || end > 16 {
		return "", p.fail("an unterminated reference")
	}
	end += p.at
	body := p.text[p.at+1 : end]
	resolved, ok := "", false
	switch {
	case strings.HasPrefix(body, "#x"):
		if hexReference.MatchString(body) {
			code, _ := strconv.ParseInt(body[2:], 16, 64)
			if !isXMLChar(rune(code)) {
				return "", p.fail("a reference to a character XML does not allow")
			}
			resolved, ok = string(rune(code)), true
		}
	case strings.HasPrefix(body, "#"):
		if decimalReference.MatchString(body) {
			code, _ := strconv.ParseInt(body[1:], 10, 64)
			if code > 0x10ffff || !isXMLChar(rune(code)) {
				return "", p.fail("a reference to a character XML does not allow")
			}
			resolved, ok = string(rune(code)), true
		}
	default:
		resolved, ok = namedReferences[body]
	}
	if !ok {
		// Any other entity would need a document type declaration, which is
		// refused, so it is undeclared.
		return "", p.fail("the reference &%s; which XML does not define", body)
	}
	p.at = end + 1
	return resolved, nil
}

// charData is the text up to the next `<`, references resolved and line
// ends read as XML reads them.
func (p *xmlParser) charData() (string, bool, error) {
	var value strings.Builder
	blank := true
	for p.at < len(p.text) {
		c := p.text[p.at]
		if c == '<' {
			break
		}
		if c == '&' {
			resolved, err := p.reference()
			if err != nil {
				return "", false, err
			}
			value.WriteString(resolved)
			blank = false
			continue
		}
		if c == ']' && p.startsWith("]]>") {
			return "", false, p.fail("`]]>` in text")
		}
		if c == '\r' {
			value.WriteByte('\n')
			if p.at+1 < len(p.text) && p.text[p.at+1] == '\n' {
				p.at += 2
			} else {
				p.at++
			}
			continue
		}
		if !isXMLSpace(c) {
			blank = false
		}
		value.WriteByte(c)
		p.at++
	}
	return value.String(), blank, nil
}

// attributeValue is an attribute's quoted value, normalised as XML reads it.
func (p *xmlParser) attributeValue() (string, error) {
	if p.at >= len(p.text) || (p.text[p.at] != '"' && p.text[p.at] != '\'') {
		return "", p.fail("expected a quoted value")
	}
	quote := p.text[p.at]
	p.at++
	var value strings.Builder
	for {
		if p.at >= len(p.text) {
			return "", p.fail("an unterminated attribute value")
		}
		c := p.text[p.at]
		switch {
		case c == quote:
			p.at++
			return value.String(), nil
		case c == '<':
			return "", p.fail("`<` in an attribute value")
		case c == '&':
			resolved, err := p.reference()
			if err != nil {
				return "", err
			}
			value.WriteString(resolved)
		case c == '\r':
			value.WriteByte(' ')
			if p.at+1 < len(p.text) && p.text[p.at+1] == '\n' {
				p.at += 2
			} else {
				p.at++
			}
		case c == '\n' || c == '\t':
			value.WriteByte(' ')
			p.at++
		default:
			value.WriteByte(c)
			p.at++
		}
	}
}

func (p *xmlParser) comment() error {
	end := -1
	if p.at+4 <= len(p.text) {
		if found := strings.Index(p.text[p.at+4:], "--"); found != -1 {
			end = p.at + 4 + found
		}
	}
	if end == -1 {
		return p.fail("an unterminated comment")
	}
	if end+2 >= len(p.text) || p.text[end+2] != '>' {
		return p.fail("`--` inside a comment")
	}
	p.at = end + 3
	return nil
}

func (p *xmlParser) instruction() error {
	p.at += 2
	target, err := p.name()
	if err != nil {
		return err
	}
	if strings.ToLower(target) == "xml" {
		return p.fail("an XML declaration that is not at the start")
	}
	end := strings.Index(p.text[p.at:], "?>")
	if end == -1 {
		return p.fail("an unterminated processing instruction")
	}
	if end > 0 && !isXMLSpace(p.text[p.at]) {
		return p.fail("a processing instruction with no space after its target")
	}
	p.at += end + 2
	return nil
}

// misc skips comments, processing instructions and white space, before or
// after the root.
func (p *xmlParser) misc() error {
	for {
		p.spaces()
		switch {
		case p.startsWith("<!--"):
			if err := p.comment(); err != nil {
				return err
			}
		case p.startsWith("<?"):
			if err := p.instruction(); err != nil {
				return err
			}
		default:
			return nil
		}
	}
}

func (p *xmlParser) splitName(qname string) (string, string, error) {
	colon := strings.IndexByte(qname, ':')
	if colon == -1 {
		return "", qname, nil
	}
	prefix, local := qname[:colon], qname[colon+1:]
	if prefix == "" || local == "" || strings.IndexByte(local, ':') != -1 {
		return "", "", p.fail("the name %s, which namespaces do not allow", qname)
	}
	return prefix, local, nil
}

// parseXML is the document, refused unless it is well-formed XML 1.0 with
// namespaces, in UTF-8, with no document type declaration.
func parseXML(text string) (*xmlDocument, error) {
	if err := checkXMLChars(text); err != nil {
		return nil, err
	}
	p := &xmlParser{text: text}
	if strings.HasPrefix(text, "\xef\xbb\xbf") {
		p.at = len("\xef\xbb\xbf")
	}
	if p.startsWith("<?xml") && p.at+5 < len(text) && (isXMLSpace(text[p.at+5]) || text[p.at+5] == '?') {
		match := xmlDeclaration.FindStringSubmatch(text[p.at:])
		if match == nil {
			return nil, p.fail("an XML declaration this runtime does not read")
		}
		encoding := match[1]
		if encoding == "" {
			encoding = match[2]
		}
		if encoding != "" && strings.ToLower(encoding) != "utf-8" {
			return nil, p.fail("the encoding %s; only UTF-8 is read", encoding)
		}
		p.at += len(match[0])
	}
	if err := p.misc(); err != nil {
		return nil, err
	}
	switch {
	case p.startsWith("<!DOCTYPE"):
		return nil, p.fail("a document type declaration, which is refused")
	case p.startsWith("<!"):
		return nil, p.fail("a declaration before the root element")
	case !p.startsWith("<"):
		return nil, p.fail("expected the root element")
	}

	root, err := p.startTag(nil)
	if err != nil {
		return nil, err
	}
	var open []*xmlElement
	if !root.empty {
		open = append(open, root)
	}
	for len(open) > 0 {
		parent := open[len(open)-1]
		switch {
		case !p.startsWith("<"):
			from := p.at
			value, blank, err := p.charData()
			if err != nil {
				return nil, err
			}
			if p.at >= len(text) {
				return nil, p.fail("an element that is never closed")
			}
			parent.children = append(parent.children, &xmlChild{kind: "text", from: from, to: p.at, value: value, blank: blank})
		case p.startsWith("</"):
			parent.endFrom = p.at
			p.at += 2
			qname, err := p.name()
			if err != nil {
				return nil, err
			}
			if qname != parent.qname {
				return nil, p.fail("the end tag </%s> where </%s> was open", qname, parent.qname)
			}
			p.spaces()
			if !p.startsWith(">") {
				return nil, p.fail("an unterminated end tag")
			}
			p.at++
			parent.to = p.at
			open = open[:len(open)-1]
		case p.startsWith("<!--"):
			from := p.at
			if err := p.comment(); err != nil {
				return nil, err
			}
			parent.children = append(parent.children, &xmlChild{kind: "other", from: from, to: p.at})
		case p.startsWith("<![CDATA["):
			from := p.at
			end := strings.Index(text[from+9:], "]]>")
			if end == -1 {
				return nil, p.fail("an unterminated CDATA section")
			}
			end += from + 9
			raw := text[from+9 : end]
			value := strings.ReplaceAll(strings.ReplaceAll(raw, "\r\n", "\n"), "\r", "\n")
			p.at = end + 3
			blank := true
			for index := 0; index < len(value); index++ {
				if !isXMLSpace(value[index]) {
					blank = false
					break
				}
			}
			parent.children = append(parent.children, &xmlChild{kind: "text", from: from, to: p.at, value: value, blank: blank})
		case p.startsWith("<?"):
			from := p.at
			if err := p.instruction(); err != nil {
				return nil, err
			}
			parent.children = append(parent.children, &xmlChild{kind: "other", from: from, to: p.at})
		case p.startsWith("<!"):
			return nil, p.fail("a declaration inside the document")
		default:
			if len(open) >= MaxDepth {
				return nil, ErrTooDeep
			}
			element, err := p.startTag(parent)
			if err != nil {
				return nil, err
			}
			parent.children = append(parent.children, &xmlChild{kind: "element", element: element, from: element.from})
			if !element.empty {
				open = append(open, element)
			}
		}
	}
	if err := p.misc(); err != nil {
		return nil, err
	}
	if p.at < len(text) {
		return nil, p.fail("content after the root element")
	}
	return &xmlDocument{text: text, root: root}, nil
}

// startTag is a start tag at the cursor, its namespaces resolved against its
// parent's.
func (p *xmlParser) startTag(parent *xmlElement) (*xmlElement, error) {
	from := p.at
	p.at++
	qname, err := p.name()
	if err != nil {
		return nil, err
	}
	prefix, local, err := p.splitName(qname)
	if err != nil {
		return nil, err
	}
	var attributes []*xmlAttribute
	for {
		before := p.at
		p.spaces()
		if p.startsWith("/>") || p.startsWith(">") {
			break
		}
		if p.at >= len(p.text) {
			return nil, p.fail("an unterminated start tag")
		}
		if p.at == before {
			return nil, p.fail("expected a space before an attribute")
		}
		name, err := p.name()
		if err != nil {
			return nil, err
		}
		p.spaces()
		if !p.startsWith("=") {
			return nil, p.fail("expected `=` after an attribute's name")
		}
		p.at++
		p.spaces()
		value, err := p.attributeValue()
		if err != nil {
			return nil, err
		}
		attributePrefix, attributeLocal, err := p.splitName(name)
		if err != nil {
			return nil, err
		}
		attributes = append(attributes, &xmlAttribute{
			from: before, to: p.at, qname: name, prefix: attributePrefix, local: attributeLocal,
			value: value, declares: name == "xmlns" || attributePrefix == "xmlns",
		})
	}
	empty := p.startsWith("/>")
	if empty {
		p.at += 2
	} else {
		p.at++
	}

	inherited := rootScope
	if parent != nil {
		inherited = parent.scope
	}
	scope, err := p.declare(inherited, attributes)
	if err != nil {
		return nil, err
	}
	namespace, err := p.resolve(scope, prefix, true, qname)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, attribute := range attributes {
		if seen[attribute.qname] {
			return nil, p.fail("the attribute %s twice", attribute.qname)
		}
		seen[attribute.qname] = true
		if attribute.declares {
			attribute.namespace = xmlnsNamespace
			continue
		}
		if attribute.prefix == "" {
			continue
		}
		if attribute.namespace, err = p.resolve(scope, attribute.prefix, false, attribute.qname); err != nil {
			return nil, err
		}
		expanded := "{" + attribute.namespace + "}" + attribute.local
		if seen[expanded] {
			return nil, p.fail("the attribute %s twice", attribute.qname)
		}
		seen[expanded] = true
	}
	return &xmlElement{
		from: from, to: p.at, startTo: p.at, endFrom: p.at, empty: empty,
		qname: qname, prefix: prefix, local: local, namespace: namespace,
		attributes: attributes, inherited: inherited, scope: scope,
	}, nil
}

func (p *xmlParser) declare(inherited xmlScope, attributes []*xmlAttribute) (xmlScope, error) {
	var scope xmlScope
	for _, attribute := range attributes {
		if !attribute.declares {
			continue
		}
		prefix := attribute.local
		if attribute.qname == "xmlns" {
			prefix = ""
		}
		uri := attribute.value
		switch {
		case prefix == "xmlns":
			return nil, p.fail("a declaration of the prefix xmlns")
		case prefix == "xml" && uri != xmlNamespace:
			return nil, p.fail("the prefix xml bound to another namespace")
		case prefix != "xml" && uri == xmlNamespace:
			return nil, p.fail("the XML namespace bound to another prefix")
		case uri == xmlnsNamespace:
			return nil, p.fail("the xmlns namespace declared")
		case prefix != "" && uri == "":
			return nil, p.fail("the prefix %s declared empty", prefix)
		}
		p.declarations++
		if p.declarations > maxDeclarations {
			return nil, p.fail("more than %d namespace declarations", maxDeclarations)
		}
		if scope == nil {
			scope = xmlScope{}
			for key, value := range inherited {
				scope[key] = value
			}
		}
		scope[prefix] = uri
	}
	if scope == nil {
		return inherited, nil
	}
	return scope, nil
}

func (p *xmlParser) resolve(scope xmlScope, prefix string, element bool, qname string) (string, error) {
	if prefix == "" {
		if element {
			return scope[""], nil
		}
		return "", nil
	}
	if prefix == "xmlns" {
		return "", p.fail("the name %s, which is reserved", qname)
	}
	uri, ok := scope[prefix]
	if !ok {
		return "", p.fail("the prefix of %s, which is not declared", qname)
	}
	return uri, nil
}

// ---------------------------------------------------------------------------
// Reading a document into a tree.

// xmlKept is an element the description does not name, kept whole and
// written back as it came.
type xmlKept struct {
	element *xmlElement
	// key is the key it was decoded under, and item whether as one item of
	// the list there.
	key  string
	item bool
}

type xmlPlaced struct {
	key        string
	index      int // -1 for a field, not one item of a list written in place
	value      any
	hasDecoded bool
}

type xmlObjectOrigin struct {
	element *xmlElement
	// key is the key it was decoded under, and item whether as one item of
	// the list there.
	key        string
	item       bool
	placed     map[*xmlElement]*xmlPlaced
	attributes map[string]*xmlHeld
	// attributeKeys are the keys decoded from attributes, by attribute.
	attributeKeys map[*xmlAttribute]string
	counts        map[string]int
}

type xmlHeld struct {
	attribute *xmlAttribute
	value     any
}

type xmlListOrigin struct {
	wrapper *xmlElement
	// key is the key it was decoded under.
	key     string
	values  []any
	decoded []bool
}

type openedXML struct {
	document *xmlDocument
	tree     *Object
	objects  map[*Object]*xmlObjectOrigin
	lists    map[*Array]*xmlListOrigin
	wrappers map[*xmlElement]*xmlListOrigin
}

func xmlTyped(text, kind string) any { return scalar(text, kind) }

func xmlElementName(key string, node *XMLNode) string {
	if node.Type == "array" && !node.Wrapped {
		if node.Items != nil && node.Items.Name != "" {
			return node.Items.Name
		}
		return key
	}
	if node.Name != "" {
		return node.Name
	}
	return key
}

func xmlMatches(element *xmlElement, name string, node *XMLNode) bool {
	return element.local == name && (node.Namespace == "" || element.namespace == node.Namespace)
}

func xmlAttributeMatches(attribute *xmlAttribute, name string, node *XMLNode) bool {
	return !attribute.declares && attribute.local == name && attribute.namespace == node.Namespace
}

// decodedScalar is a decoded value's own text, kept for telling whether it
// was left alone; false for an object or a list.
func decodedScalar(value any) (any, bool) {
	switch value.(type) {
	case *Object, *Array:
		return nil, false
	}
	return value, true
}

func (o *openedXML) object(element *xmlElement, node *XMLNode, at string, item bool) (*Object, error) {
	out := NewObject()
	origin := &xmlObjectOrigin{
		element:       element,
		key:           at,
		item:          item,
		placed:        map[*xmlElement]*xmlPlaced{},
		attributes:    map[string]*xmlHeld{},
		attributeKeys: map[*xmlAttribute]string{},
		counts:        map[string]int{},
	}
	for _, attribute := range element.attributes {
		for _, key := range node.propertyOrder {
			property := node.Properties[key]
			if !property.Attribute {
				continue
			}
			name := property.Name
			if name == "" {
				name = key
			}
			if !xmlAttributeMatches(attribute, name, property) {
				continue
			}
			value := xmlTyped(attribute.value, property.Type)
			out.Set(key, value)
			origin.attributes[key] = &xmlHeld{attribute: attribute, value: value}
			origin.attributeKeys[attribute] = key
			break
		}
	}
	kept := 0
	for _, child := range element.children {
		switch child.kind {
		case "other":
			continue
		case "text":
			if !child.blank {
				return nil, xmlError("<%s> holds text among its elements, which a tree cannot carry", element.qname)
			}
			continue
		}
		childElement := child.element
		found := ""
		for _, key := range node.propertyOrder {
			property := node.Properties[key]
			if !property.Attribute && xmlMatches(childElement, xmlElementName(key, property), property) {
				found = key
				break
			}
		}
		if found == "" {
			key := keptPrefix + strconv.Itoa(kept)
			kept++
			out.Set(key, &xmlKept{element: childElement, key: key})
			origin.placed[childElement] = &xmlPlaced{key: key, index: -1}
			continue
		}
		property := node.Properties[found]
		if property.Type == "array" && !property.Wrapped {
			existing, present := out.Get(found)
			list, _ := existing.(*Array)
			if !present || list == nil {
				list = &Array{}
				out.Set(found, list)
			}
			value, err := o.value(childElement, property.Items, found, true)
			if err != nil {
				return nil, err
			}
			index := len(list.Items)
			list.Items = append(list.Items, value)
			decoded, has := decodedScalar(value)
			origin.placed[childElement] = &xmlPlaced{key: found, index: index, value: decoded, hasDecoded: has}
			origin.counts[found] = index + 1
			continue
		}
		if _, twice := out.Get(found); twice {
			return nil, xmlError("<%s> holds <%s> twice, where its contract has one", element.qname, childElement.qname)
		}
		var value any
		var err error
		if property.Type == "array" {
			value, err = o.wrapped(childElement, property, found)
		} else {
			value, err = o.value(childElement, property, found, false)
		}
		if err != nil {
			return nil, err
		}
		out.Set(found, value)
		decoded, has := decodedScalar(value)
		origin.placed[childElement] = &xmlPlaced{key: found, index: -1, value: decoded, hasDecoded: has}
	}
	o.objects[out] = origin
	return out, nil
}

func (o *openedXML) wrapped(wrapper *xmlElement, node *XMLNode, key string) (*Array, error) {
	items := node.Items
	list := &Array{}
	origin := &xmlListOrigin{wrapper: wrapper, key: key}
	for _, child := range wrapper.children {
		switch child.kind {
		case "other":
			continue
		case "text":
			if !child.blank {
				return nil, xmlError("<%s> holds text among its items", wrapper.qname)
			}
			continue
		}
		if !xmlMatches(child.element, items.Name, items) {
			return nil, xmlError("<%s> holds <%s>, which is not one of its items", wrapper.qname, child.element.qname)
		}
		value, err := o.value(child.element, items, key, true)
		if err != nil {
			return nil, err
		}
		list.Items = append(list.Items, value)
		decoded, has := decodedScalar(value)
		origin.values = append(origin.values, decoded)
		origin.decoded = append(origin.decoded, has)
	}
	o.lists[list] = origin
	o.wrappers[wrapper] = origin
	return list, nil
}

func (o *openedXML) value(element *xmlElement, node *XMLNode, key string, item bool) (any, error) {
	if node.Type == "object" {
		return o.object(element, node, key, item)
	}
	// What no instruction reads by value is moved or removed whole, as it came.
	if node.Type == "any" {
		return &xmlKept{element: element, key: key, item: item}, nil
	}
	if node.Type == "array" {
		return nil, xmlError("<%s> is described as a list of lists", element.qname)
	}
	for _, attribute := range element.attributes {
		if !attribute.declares {
			return nil, xmlError("<%s> carries attributes its contract does not describe", element.qname)
		}
	}
	var text strings.Builder
	for _, child := range element.children {
		switch child.kind {
		case "element":
			return nil, xmlError("<%s> holds elements where its contract has a value", element.qname)
		case "text":
			text.WriteString(child.value)
		}
	}
	return xmlTyped(text.String(), node.Type), nil
}

// xmlUnchanged says whether value is still what was decoded, so the element
// can go back as it came.
func xmlUnchanged(value, decoded any, has bool) bool {
	if !has {
		return false
	}
	left, leftNumber := value.(Number)
	right, rightNumber := decoded.(Number)
	if leftNumber || rightNumber {
		return leftNumber && rightNumber && left == right
	}
	switch v := value.(type) {
	case string:
		d, ok := decoded.(string)
		return ok && v == d
	case bool:
		d, ok := decoded.(bool)
		return ok && v == d
	}
	return false
}

// IsXMLMediaType says whether a media type is XML: application/xml,
// text/xml or anything +xml.
func IsXMLMediaType(contentType string) bool {
	media := strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
	return media == "application/xml" || media == "text/xml" || strings.HasSuffix(media, "+xml")
}

var charsetParameter = regexp.MustCompile(`(?i);\s*charset\s*=\s*"?([^";\s]+)"?`)

func openXML(body *XMLBody, text, contentType string) (*openedXML, error) {
	if match := charsetParameter.FindStringSubmatch(contentType); match != nil && strings.ToLower(match[1]) != "utf-8" {
		return nil, xmlError("it is declared as %s; only UTF-8 is read", match[1])
	}
	document, err := parseXML(text)
	if err != nil {
		return nil, err
	}
	opened := &openedXML{
		document: document,
		objects:  map[*Object]*xmlObjectOrigin{},
		lists:    map[*Array]*xmlListOrigin{},
		wrappers: map[*xmlElement]*xmlListOrigin{},
	}
	tree, err := opened.object(document.root, body.Read, "", false)
	if err != nil {
		return nil, err
	}
	opened.tree = tree
	return opened, nil
}

// ---------------------------------------------------------------------------
// Writing the tree back.

func escapeXMLText(text string) string {
	var out strings.Builder
	for index := 0; index < len(text); index++ {
		switch c := text[index]; c {
		case '&':
			out.WriteString("&amp;")
		case '<':
			out.WriteString("&lt;")
		case '>':
			out.WriteString("&gt;")
		case '\r':
			out.WriteString("&#13;")
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

func escapeXMLAttribute(text string) string {
	var out strings.Builder
	for index := 0; index < len(text); index++ {
		switch c := text[index]; c {
		case '&':
			out.WriteString("&amp;")
		case '<':
			out.WriteString("&lt;")
		case '"':
			out.WriteString("&quot;")
		case '\t':
			out.WriteString("&#9;")
		case '\n':
			out.WriteString("&#10;")
		case '\r':
			out.WriteString("&#13;")
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

type xmlDeclarations [][2]string

func (d xmlDeclarations) written() string {
	var out strings.Builder
	for _, each := range d {
		if each[0] == "" {
			out.WriteString(` xmlns="` + escapeXMLAttribute(each[1]) + `"`)
		} else {
			out.WriteString(` xmlns:` + each[0] + `="` + escapeXMLAttribute(each[1]) + `"`)
		}
	}
	return out.String()
}

func declaring(scope xmlScope, declarations xmlDeclarations) xmlScope {
	if len(declarations) == 0 {
		return scope
	}
	out := xmlScope{}
	for key, value := range scope {
		out[key] = value
	}
	for _, each := range declarations {
		out[each[0]] = each[1]
	}
	return out
}

type xmlTarget struct {
	local     string
	prefix    string
	namespace string
}

type xmlNaming struct {
	qname        string
	declarations xmlDeclarations
}

// xmlFrom is the element a value was decoded from, and the key it was
// decoded under: a place the description does not name keeps the name it
// had, as long as it is still under that key.
type xmlFrom struct {
	element *xmlElement
	key     string
	item    bool
}

type xmlWriter struct {
	opened *openedXML
	text   string
	instrs []*Instr
	depth  int
	path   []string
}

type xmlRefusal struct{ err error }

func (w *xmlWriter) refuse(format string, args ...any) {
	panic(xmlRefusal{&TransformError{ChangeID: xmlWriterOf(w.instrs, w.path, w.depth), Message: fmt.Sprintf(format, args...), Kind: "transform"}})
}

func (w *xmlWriter) where() string {
	if len(w.path) == 0 {
		return "the body"
	}
	return "/" + strings.Join(w.path, "/")
}

func (w *xmlWriter) raw(from, to int) string { return w.text[from:to] }

func (w *xmlWriter) at(key string, write func() string) string {
	w.path = append(w.path, key)
	out := write()
	w.path = w.path[:len(w.path)-1]
	return out
}

func (w *xmlWriter) scalarText(value any) string {
	var text string
	switch v := value.(type) {
	case string:
		text = v
	case bool:
		text = strconv.FormatBool(v)
	case Number:
		text = string(v)
	case nil:
		w.refuse("%s is null, which XML has no way to write", w.where())
	default:
		w.refuse("%s holds a value XML cannot write as text", w.where())
	}
	if checkXMLChars(text) != nil {
		w.refuse("%s holds a character XML does not allow", w.where())
	}
	return text
}

func (w *xmlWriter) naming(target xmlTarget, scope xmlScope, attribute bool) xmlNaming {
	if !isNCName(target.local) {
		w.refuse("%s would be written as %s, which is not a name", w.where(), target.local)
	}
	if target.prefix != "" {
		if !isNCName(target.prefix) || target.prefix == "xmlns" {
			w.refuse("%s has the prefix %s, which is not one XML allows", w.where(), target.prefix)
		}
		bound, isBound := scope[target.prefix]
		qname := target.prefix + ":" + target.local
		if target.namespace == "" {
			if !isBound {
				w.refuse("%s has the prefix %s, which is not declared", w.where(), target.prefix)
			}
			return xmlNaming{qname: qname}
		}
		if isBound && bound == target.namespace {
			return xmlNaming{qname: qname}
		}
		return xmlNaming{qname: qname, declarations: xmlDeclarations{{target.prefix, target.namespace}}}
	}
	if target.namespace == "" {
		return xmlNaming{qname: target.local}
	}
	if attribute {
		// An attribute without a prefix has no namespace, so it takes one bound here.
		var prefixes []string
		for key, uri := range scope {
			if key != "" && uri == target.namespace {
				prefixes = append(prefixes, key)
			}
		}
		if len(prefixes) == 0 {
			w.refuse("%s is in a namespace no prefix is declared for", w.where())
		}
		sort.Strings(prefixes)
		return xmlNaming{qname: prefixes[0] + ":" + target.local}
	}
	if scope[""] == target.namespace {
		return xmlNaming{qname: target.local}
	}
	return xmlNaming{qname: target.local, declarations: xmlDeclarations{{"", target.namespace}}}
}

// restoring is the declarations that give an element written under scope
// the namespaces it had where it came from, and the scope inside it.
func (w *xmlWriter) restoring(element *xmlElement, scope xmlScope) (xmlDeclarations, xmlScope) {
	own := map[string]bool{}
	for _, attribute := range element.attributes {
		if attribute.declares {
			if attribute.qname == "xmlns" {
				own[""] = true
			} else {
				own[attribute.local] = true
			}
		}
	}
	seen := map[string]bool{}
	var prefixes []string
	for key := range element.inherited {
		if !seen[key] {
			seen[key] = true
			prefixes = append(prefixes, key)
		}
	}
	for key := range scope {
		if !seen[key] {
			seen[key] = true
			prefixes = append(prefixes, key)
		}
	}
	sort.Strings(prefixes)
	var declarations xmlDeclarations
	for _, prefix := range prefixes {
		if own[prefix] || prefix == "xml" {
			continue
		}
		was, wasBound := element.inherited[prefix]
		now, nowBound := scope[prefix]
		if prefix == "" {
			if was != now {
				declarations = append(declarations, [2]string{"", was})
			}
			continue
		}
		// A prefix bound here and not where the element came from means
		// nothing to it, since nothing inside it could have used it.
		if wasBound && (!nowBound || was != now) {
			declarations = append(declarations, [2]string{prefix, was})
		}
	}
	inner := xmlScope{}
	for key, value := range declaring(scope, declarations) {
		inner[key] = value
	}
	for _, attribute := range element.attributes {
		if attribute.declares {
			if attribute.qname == "xmlns" {
				inner[""] = attribute.value
			} else {
				inner[attribute.local] = attribute.value
			}
		}
	}
	return declarations, inner
}

func (w *xmlWriter) targetFor(key string, node *XMLNode, item bool, from *xmlFrom) xmlTarget {
	kept := from != nil && from.key == key && from.item == item
	if item {
		var items *XMLNode
		if node != nil && node.Type == "array" {
			items = node.Items
		}
		if items == nil && kept {
			return xmlTarget{local: from.element.local, prefix: from.element.prefix}
		}
		target := xmlTarget{local: key}
		if node != nil && node.Wrapped && node.Name != "" {
			target.local = node.Name
		}
		if items != nil {
			if items.Name != "" {
				target.local = items.Name
			}
			target.prefix, target.namespace = items.Prefix, items.Namespace
		}
		return target
	}
	if node == nil && kept {
		return xmlTarget{local: from.element.local, prefix: from.element.prefix}
	}
	target := xmlTarget{local: key}
	if node != nil {
		if node.Name != "" {
			target.local = node.Name
		}
		target.prefix, target.namespace = node.Prefix, node.Namespace
	}
	return target
}

// fromOf is where an object was decoded from, if it was.
func (w *xmlWriter) fromOf(value *Object) *xmlFrom {
	origin, ok := w.opened.objects[value]
	if !ok {
		return nil
	}
	return &xmlFrom{element: origin.element, key: origin.key, item: origin.item}
}

func (w *xmlWriter) named(element *xmlElement, target xmlTarget) bool {
	return element.local == target.local &&
		(target.prefix == "" || element.prefix == target.prefix) &&
		(target.namespace == "" || element.namespace == target.namespace)
}

func (w *xmlWriter) attribute(value any, target xmlTarget, scope xmlScope) (string, xmlNaming) {
	naming := w.naming(target, scope, true)
	return " " + naming.qname + `="` + escapeXMLAttribute(w.scalarText(value)) + `"`, naming
}

func propertyOf(node *XMLNode, key string) *XMLNode {
	if node == nil || node.Properties == nil {
		return nil
	}
	return node.Properties[key]
}

func xmlTrailingSpace(element *xmlElement, text string) string {
	if len(element.children) == 0 {
		return ""
	}
	last := element.children[len(element.children)-1]
	if last.kind != "text" || !last.blank {
		return ""
	}
	raw := text[last.from:last.to]
	if strings.HasPrefix(raw, "<") {
		return ""
	}
	return raw
}

func (w *xmlWriter) object(value *Object, target xmlTarget, node *XMLNode, scope xmlScope, root bool) string {
	origin, decoded := w.opened.objects[value]
	if !decoded {
		return w.fresh(value, target, node, scope)
	}
	element := origin.element
	isAttribute := func(key string) bool {
		property := propertyOf(node, key)
		return property != nil && property.Attribute
	}
	renamed := !root && !w.named(element, target)
	var restored xmlDeclarations
	inner := element.scope
	if !root {
		restored, inner = w.restoring(element, scope)
	}
	naming := xmlNaming{qname: element.qname}
	if renamed {
		naming = w.naming(target, inner, false)
	}
	inner = declaring(inner, naming.declarations)

	var attributes strings.Builder
	changed := false
	var added xmlDeclarations
	for _, attribute := range element.attributes {
		key, held := origin.attributeKeys[attribute]
		if !held {
			attributes.WriteString(w.raw(attribute.from, attribute.to))
			continue
		}
		now, present := value.Get(key)
		if !present || !isAttribute(key) {
			changed = true
			continue
		}
		if xmlUnchanged(now, origin.attributes[key].value, true) {
			attributes.WriteString(w.raw(attribute.from, attribute.to))
			continue
		}
		changed = true
		qname := attribute.qname
		attributes.WriteString(w.at(key, func() string {
			return " " + qname + `="` + escapeXMLAttribute(w.scalarText(now)) + `"`
		}))
	}
	for _, key := range value.Keys() {
		if _, held := origin.attributes[key]; !isAttribute(key) || held {
			continue
		}
		changed = true
		now, _ := value.Get(key)
		var made xmlNaming
		attributes.WriteString(w.at(key, func() string {
			text, naming := w.attribute(now, w.targetFor(key, propertyOf(node, key), false, nil), inner)
			made = naming
			return text
		}))
		added = append(added, made.declarations...)
		inner = declaring(inner, made.declarations)
	}

	var content strings.Builder
	done := map[string]bool{}
	for _, child := range element.children {
		if child.kind != "element" {
			content.WriteString(w.raw(child.from, child.to))
			continue
		}
		placed := origin.placed[child.element]
		key := placed.key
		now, present := value.Get(key)
		if !present || isAttribute(key) {
			continue
		}
		property := propertyOf(node, key)
		from := &xmlFrom{element: child.element, key: key, item: placed.index >= 0}
		content.WriteString(w.at(key, func() string {
			if placed.index < 0 {
				done[key] = true
				return w.field(key, now, property, inner, from, placed.value, placed.hasDecoded)
			}
			wrapped := property != nil && property.Type == "array" && property.Wrapped
			if list, isList := now.(*Array); isList && !wrapped {
				// One item of a list written in place, where that item was;
				// any the list gained follow its last.
				done[key] = true
				var out strings.Builder
				if placed.index < len(list.Items) {
					item := list.Items[placed.index]
					out.WriteString(w.at(strconv.Itoa(placed.index), func() string {
						return w.item(key, item, property, inner, from, placed.value, placed.hasDecoded)
					}))
				}
				if placed.index == origin.counts[key]-1 {
					for index := placed.index + 1; index < len(list.Items); index++ {
						item := list.Items[index]
						out.WriteString(w.at(strconv.Itoa(index), func() string {
							return w.item(key, item, property, inner, nil, nil, false)
						}))
					}
				}
				return out.String()
			}
			if placed.index != 0 {
				return ""
			}
			// The list became one value, or a list written some other way,
			// which stands where its first item did.
			done[key] = true
			return w.field(key, now, property, inner, from, placed.value, placed.hasDecoded)
		}))
	}
	var fresh strings.Builder
	for _, key := range value.Keys() {
		if done[key] || isAttribute(key) {
			continue
		}
		now, _ := value.Get(key)
		fresh.WriteString(w.at(key, func() string {
			return w.field(key, now, propertyOf(node, key), inner, nil, nil, false)
		}))
	}
	body := content.String()
	if fresh.Len() > 0 {
		tail := xmlTrailingSpace(element, w.text)
		body = body[:len(body)-len(tail)] + fresh.String() + tail
	}

	declarations := append(append(append(xmlDeclarations{}, restored...), naming.declarations...), added...)
	same := !renamed && !changed && len(declarations) == 0
	head := "<" + naming.qname + attributes.String() + declarations.written()
	if element.empty && body == "" {
		if same {
			return w.raw(element.from, element.to)
		}
		return head + "/>"
	}
	start := head + ">"
	if same && !element.empty {
		start = w.raw(element.from, element.startTo)
	}
	end := "</" + naming.qname + ">"
	if !renamed && !element.empty {
		end = w.raw(element.endFrom, element.to)
	}
	return start + body + end
}

func (w *xmlWriter) fresh(value *Object, target xmlTarget, node *XMLNode, scope xmlScope) string {
	naming := w.naming(target, scope, false)
	inner := declaring(scope, naming.declarations)
	declarations := append(xmlDeclarations{}, naming.declarations...)
	var attributes strings.Builder
	for _, key := range value.Keys() {
		property := propertyOf(node, key)
		if property == nil || !property.Attribute {
			continue
		}
		now, _ := value.Get(key)
		var made xmlNaming
		attributes.WriteString(w.at(key, func() string {
			text, naming := w.attribute(now, w.targetFor(key, property, false, nil), inner)
			made = naming
			return text
		}))
		declarations = append(declarations, made.declarations...)
		inner = declaring(inner, made.declarations)
	}
	var content strings.Builder
	for _, key := range value.Keys() {
		property := propertyOf(node, key)
		if property != nil && property.Attribute {
			continue
		}
		now, _ := value.Get(key)
		content.WriteString(w.at(key, func() string {
			return w.field(key, now, property, inner, nil, nil, false)
		}))
	}
	head := "<" + naming.qname + attributes.String() + declarations.written()
	if content.Len() == 0 {
		return head + "/>"
	}
	return head + ">" + content.String() + "</" + naming.qname + ">"
}

func (w *xmlWriter) field(key string, value any, node *XMLNode, scope xmlScope, from *xmlFrom, decoded any, has bool) string {
	switch v := value.(type) {
	case *xmlKept:
		return w.kept(v, key, node, scope, false)
	case *Array:
		list := w.opened.lists[v]
		if list == nil && from != nil && !from.item {
			list = w.opened.wrappers[from.element]
		}
		wrapped := list != nil
		if node != nil && node.Type == "array" {
			wrapped = node.Wrapped
		}
		if wrapped {
			return w.wrapped(key, v, node, scope, list)
		}
		var out strings.Builder
		for index, item := range v.Items {
			out.WriteString(w.at(strconv.Itoa(index), func() string {
				return w.item(key, item, node, scope, nil, nil, false)
			}))
		}
		return out.String()
	case *Object:
		return w.object(v, w.targetFor(key, node, false, w.fromOf(v)), node, scope, false)
	}
	return w.scalar(value, w.targetFor(key, node, false, from), scope, from, decoded, has)
}

func (w *xmlWriter) wrapped(key string, value *Array, node *XMLNode, scope xmlScope, list *xmlListOrigin) string {
	var from *xmlFrom
	if list != nil {
		from = &xmlFrom{element: list.wrapper, key: list.key}
	}
	target := w.targetFor(key, node, false, from)
	if list == nil {
		naming := w.naming(target, scope, false)
		inner := declaring(scope, naming.declarations)
		var items strings.Builder
		for index, item := range value.Items {
			item := item
			items.WriteString(w.at(strconv.Itoa(index), func() string {
				return w.item(key, item, node, inner, nil, nil, false)
			}))
		}
		head := "<" + naming.qname + naming.declarations.written()
		if items.Len() == 0 {
			return head + "/>"
		}
		return head + ">" + items.String() + "</" + naming.qname + ">"
	}
	wrapper := list.wrapper
	renamed := !w.named(wrapper, target)
	restored, inner := w.restoring(wrapper, scope)
	naming := xmlNaming{qname: wrapper.qname}
	if renamed {
		naming = w.naming(target, inner, false)
	}
	inner = declaring(inner, naming.declarations)
	last := -1
	for at, child := range wrapper.children {
		if child.kind == "element" {
			last = at
		}
	}
	var content strings.Builder
	index := 0
	for at, child := range wrapper.children {
		if child.kind != "element" {
			content.WriteString(w.raw(child.from, child.to))
			continue
		}
		position := index
		if position < len(value.Items) {
			item := value.Items[position]
			from := &xmlFrom{element: child.element, key: list.key, item: true}
			content.WriteString(w.at(strconv.Itoa(position), func() string {
				return w.item(key, item, node, inner, from, list.values[position], list.decoded[position])
			}))
		}
		index++
		if at == last {
			for extra := index; extra < len(value.Items); extra++ {
				item := value.Items[extra]
				content.WriteString(w.at(strconv.Itoa(extra), func() string {
					return w.item(key, item, node, inner, nil, nil, false)
				}))
			}
		}
	}
	body := content.String()
	if last == -1 && len(value.Items) > 0 {
		var items strings.Builder
		for position, item := range value.Items {
			item := item
			items.WriteString(w.at(strconv.Itoa(position), func() string {
				return w.item(key, item, node, inner, nil, nil, false)
			}))
		}
		tail := xmlTrailingSpace(wrapper, w.text)
		body = body[:len(body)-len(tail)] + items.String() + tail
	}
	declarations := append(append(xmlDeclarations{}, restored...), naming.declarations...)
	same := !renamed && len(declarations) == 0
	var attributes strings.Builder
	for _, attribute := range wrapper.attributes {
		attributes.WriteString(w.raw(attribute.from, attribute.to))
	}
	head := "<" + naming.qname + attributes.String() + declarations.written()
	if wrapper.empty && body == "" {
		if same {
			return w.raw(wrapper.from, wrapper.to)
		}
		return head + "/>"
	}
	start := head + ">"
	if same && !wrapper.empty {
		start = w.raw(wrapper.from, wrapper.startTo)
	}
	end := "</" + naming.qname + ">"
	if !renamed && !wrapper.empty {
		end = w.raw(wrapper.endFrom, wrapper.to)
	}
	return start + body + end
}

func (w *xmlWriter) item(key string, value any, node *XMLNode, scope xmlScope, from *xmlFrom, decoded any, has bool) string {
	switch v := value.(type) {
	case *xmlKept:
		return w.kept(v, key, node, scope, true)
	case *Array:
		w.refuse("%s is a list inside a list, which XML cannot write", w.where())
	case *Object:
		var items *XMLNode
		if node != nil && node.Type == "array" {
			items = node.Items
		}
		return w.object(v, w.targetFor(key, node, true, w.fromOf(v)), items, scope, false)
	}
	return w.scalar(value, w.targetFor(key, node, true, from), scope, from, decoded, has)
}

func (w *xmlWriter) kept(value *xmlKept, key string, node *XMLNode, scope xmlScope, item bool) string {
	element := value.element
	if strings.HasPrefix(key, keptPrefix) {
		return w.raw(element.from, element.to)
	}
	target := w.targetFor(key, node, item, &xmlFrom{element: element, key: value.key, item: value.item})
	restored, inner := w.restoring(element, scope)
	renamed := !w.named(element, target)
	if !renamed && len(restored) == 0 {
		return w.raw(element.from, element.to)
	}
	naming := xmlNaming{qname: element.qname}
	if renamed {
		naming = w.naming(target, inner, false)
	}
	var attributes strings.Builder
	for _, attribute := range element.attributes {
		attributes.WriteString(w.raw(attribute.from, attribute.to))
	}
	declarations := append(append(xmlDeclarations{}, restored...), naming.declarations...)
	head := "<" + naming.qname + attributes.String() + declarations.written()
	if element.empty {
		return head + "/>"
	}
	return head + ">" + w.raw(element.startTo, element.endFrom) + "</" + naming.qname + ">"
}

func (w *xmlWriter) scalar(value any, target xmlTarget, scope xmlScope, from *xmlFrom, decoded any, has bool) string {
	text := w.scalarText(value)
	if from != nil && has && w.named(from.element, target) {
		origin := from.element
		if xmlUnchanged(value, decoded, has) {
			return w.raw(origin.from, origin.to)
		}
		start := w.raw(origin.from, origin.startTo)
		end := "</" + origin.qname + ">"
		if origin.empty {
			start = w.raw(origin.from, origin.startTo-2) + ">"
		} else {
			end = w.raw(origin.endFrom, origin.to)
		}
		return start + escapeXMLText(text) + end
	}
	naming := w.naming(target, scope, false)
	head := "<" + naming.qname + naming.declarations.written()
	if text == "" {
		return head + "/>"
	}
	return head + ">" + escapeXMLText(text) + "</" + naming.qname + ">"
}

// xmlWriterOf is the change that last wrote at or under the first key of
// path, for naming a refusal.
func xmlWriterOf(instrs []*Instr, path []string, depth int) string {
	for index := len(instrs) - 1; index >= 0; index-- {
		if len(path) == 0 {
			return instrs[index].C
		}
		for _, touched := range touchedPaths(instrs[index], nil) {
			if depth < len(touched) && touched[depth] == path[0] {
				return instrs[index].C
			}
		}
	}
	if len(instrs) > 0 {
		return instrs[0].C
	}
	return ""
}

// closeXML is the tree written back into the document it was read from.
func closeXML(opened *openedXML, write *XMLNode, instrs []*Instr, depth int) (out string, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			refusal, ok := recovered.(xmlRefusal)
			if !ok {
				panic(recovered)
			}
			out, err = "", refusal.err
		}
	}()
	w := &xmlWriter{opened: opened, text: opened.document.text, instrs: instrs, depth: depth}
	root := opened.document.root
	body := w.object(opened.tree, xmlTarget{local: root.local}, write, root.inherited, true)
	return w.raw(0, root.from) + body + w.raw(root.to, len(w.text)), nil
}

// runXML decodes a body by its description, runs the instructions over it
// and writes it back.
func runXML(instrs []*Instr, body *XMLBody, text, contentType string, limits Limits) (string, *Result, error) {
	if len(instrs) == 0 {
		return text, &Result{Applied: map[string]int{}, Folded: map[string]bool{}}, nil
	}
	opened, err := openXML(body, text, contentType)
	if err != nil {
		return "", nil, err
	}
	result, err := Execute(opened.tree, instrs, limits)
	if err != nil {
		return "", nil, err
	}
	out, err := closeXML(opened, body.Write, instrs, 0)
	if err != nil {
		return "", nil, err
	}
	return out, result, nil
}

// ---------------------------------------------------------------------------
// Reading the description from a program.

var xmlTypes = map[string]bool{"object": true, "array": true, "string": true, "integer": true, "number": true, "boolean": true, "any": true}
var xmlScalars = map[string]bool{"string": true, "integer": true, "number": true, "boolean": true}

func decodeXMLNode(raw any, where string, depth int) (*XMLNode, error) {
	if depth > 256 {
		return nil, programError("%s nests too deeply", where)
	}
	value, err := asObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := expectKeys(value, []string{"type", "name", "namespace", "prefix", "attribute", "wrapped", "properties", "items"}, where); err != nil {
		return nil, err
	}
	kind, isString := field(value, "type").(string)
	if !isString || !xmlTypes[kind] {
		return nil, programError("%s.type is not a type", where)
	}
	node := &XMLNode{Type: kind}
	for _, key := range []string{"name", "prefix"} {
		present, ok := value.Get(key)
		if !ok {
			continue
		}
		name, err := asString(present, where+"."+key)
		if err != nil {
			return nil, err
		}
		if !isNCName(name) || (key == "prefix" && name == "xmlns") {
			return nil, programError("%s.%s is not a name XML allows", where, key)
		}
		if key == "name" {
			node.Name = name
		} else {
			node.Prefix = name
		}
	}
	if present, ok := value.Get("namespace"); ok {
		namespace, err := asString(present, where+".namespace")
		if err != nil {
			return nil, err
		}
		if namespace == "" {
			return nil, programError("%s.namespace is empty", where)
		}
		node.Namespace = namespace
	}
	if node.Attribute, err = onlyTrue(value, "attribute", where); err != nil {
		return nil, err
	}
	if node.Attribute && !xmlScalars[kind] {
		return nil, programError("%s is an attribute, which only holds a value", where)
	}
	if node.Wrapped, err = onlyTrue(value, "wrapped", where); err != nil {
		return nil, err
	}
	if node.Wrapped && kind != "array" {
		return nil, programError("%s is wrapped, which only a list is", where)
	}
	if present, ok := value.Get("properties"); ok {
		if kind != "object" {
			return nil, programError("%s has properties, which only an object has", where)
		}
		properties, err := asObject(present, where+".properties")
		if err != nil {
			return nil, err
		}
		node.Properties = map[string]*XMLNode{}
		elements, attributes := map[string]bool{}, map[string]bool{}
		for _, key := range properties.Keys() {
			// Elements nothing names are kept under keys that begin with NUL.
			if isUnsafeKey(key) || strings.Contains(key, "\x00") {
				return nil, programError("%s.properties may not name %q", where, key)
			}
			entry, _ := properties.Get(key)
			property, err := decodeXMLNode(entry, where+".properties."+key, depth+1)
			if err != nil {
				return nil, err
			}
			name := xmlElementName(key, property)
			seen := elements
			if property.Attribute {
				seen = attributes
			}
			identity := property.Namespace + " " + name
			if seen[identity] {
				return nil, programError("%s.properties write two fields as %s", where, name)
			}
			seen[identity] = true
			node.Properties[key] = property
			node.propertyOrder = append(node.propertyOrder, key)
		}
	}
	if present, ok := value.Get("items"); ok {
		if kind != "array" {
			return nil, programError("%s has items, which only a list has", where)
		}
		items, err := decodeXMLNode(present, where+".items", depth+1)
		if err != nil {
			return nil, err
		}
		if items.Type == "array" {
			return nil, programError("%s is a list of lists, which XML has no form for", where)
		}
		if items.Attribute {
			return nil, programError("%s.items cannot be an attribute", where)
		}
		if items.Name == "" {
			return nil, programError("%s.items must be named", where)
		}
		node.Items = items
	} else if kind == "array" {
		return nil, programError("%s is a list with no items described", where)
	}
	return node, nil
}

func decodeXMLBody(raw any, where string) (*XMLBody, error) {
	value, err := asObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := expectKeys(value, []string{"read", "write"}, where); err != nil {
		return nil, err
	}
	read, err := decodeXMLNode(field(value, "read"), where+".read", 0)
	if err != nil {
		return nil, err
	}
	write, err := decodeXMLNode(field(value, "write"), where+".write", 0)
	if err != nil {
		return nil, err
	}
	if read.Type != "object" || write.Type != "object" {
		return nil, programError("%s must describe an object at the root", where)
	}
	return &XMLBody{Read: read, Write: write}, nil
}

func decodeXMLProgram(raw any, where string) (*XMLProgram, error) {
	value, err := asObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := expectKeys(value, []string{"request", "response"}, where); err != nil {
		return nil, err
	}
	out := &XMLProgram{Response: map[string]*XMLBody{}}
	if present, ok := value.Get("request"); ok {
		if out.Request, err = decodeXMLBody(present, where+".request"); err != nil {
			return nil, err
		}
	}
	if present, ok := value.Get("response"); ok {
		statuses, err := asObject(present, where+".response")
		if err != nil {
			return nil, err
		}
		for _, status := range statuses.Keys() {
			if !statusKey.MatchString(status) {
				return nil, programError("%s.response has an invalid status key %q", where, status)
			}
			entry, _ := statuses.Get(status)
			body, err := decodeXMLBody(entry, where+".response."+status)
			if err != nil {
				return nil, err
			}
			out.Response[strings.ToLower(status)] = body
		}
	}
	return out, nil
}

// readsMapValues says whether any instruction reaches a map's values.
func readsMapValues(lists ...[]*Instr) bool {
	for _, list := range lists {
		for _, instr := range list {
			for _, path := range touchedPaths(instr, nil) {
				for _, segment := range path {
					if segment == eachValue {
						return true
					}
				}
			}
		}
	}
	return false
}
