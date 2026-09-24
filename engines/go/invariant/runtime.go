package invariant

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func itoa(n int) string { return strconv.Itoa(n) }

// Site is the compiled work for one operation of one contract.
type Site struct {
	Request []*Instr
	// Response is keyed by status as OpenAPI writes it, lowercased: an exact
	// status, a class such as 2xx, or default.
	Response map[string][]*Instr
	// Envelope is the program over the whole request, where a Change reaches
	// a parameter.
	Envelope *Envelope
	// Template is the site's path, split on "/", as the contract writes it.
	Template []string
	// Form is how the request body is written when it arrives form-encoded.
	Form *Form
	// XML is how each body is written when it arrives as XML: the request's,
	// and each status's.
	XML *XMLProgram
	// Status holds the success statuses an old caller is answered as
	// another, applied in turn to the status the provider answered with.
	Status []StatusRule
}

// StatusRule answers the provider's From as To, with no body where Empty
// says the caller's contract promised none.
type StatusRule struct {
	From  int
	To    int
	Empty bool
	C     string
}

// emptyStatus says whether an answer with this status never carries a body,
// whatever a rule says.
func emptyStatus(status int) bool { return status == 204 || status == 205 }

// Route moves an old endpoint to the one the canonical handler serves.
type Route struct {
	Method   string
	ToMethod string
	From     []string
	To       []string
	ChangeID string
}

// Retired is an endpoint a contract had that the current one does not.
type Retired struct {
	Method   string
	Path     string
	Guidance string
	C        string
	// Refuse means refused without reaching the provider; otherwise passed on.
	Refuse bool
}

// Identity is one way a request names its contract, tried in order: a
// header, a URL prefix, the authenticated principal's pin, or a default.
type Identity struct {
	Kind  string
	Name  string
	Label string
	// Prefixes are a urlPrefix strategy's map, in the order declared.
	Prefixes [][2]string
}

// Contract is one historical contract, compiled straight to current.
type Contract struct {
	Label string
	// BasePath is where this contract's callers send requests, when it is not
	// the current base path.
	BasePath  *string
	Routes    []Route
	Sites     map[string]*Site
	siteOrder []string
	Outbound  map[string][]*Instr
	Behaviors []string
	Retired   []Retired
	blocks    blocks
}

// Program is a decoded program.
type Program struct {
	API          string
	Current      string
	CurrentLabel string
	Contracts    map[string]*Contract
	order        []string
	// BasePath is the path the API is served under, or "" at the root.
	BasePath string
	// Identity is how requests name their contract, when the program says.
	Identity []Identity
}

// Runtime runs a program.
type Runtime struct {
	program   *Program
	limits    Limits
	identity  []Identity
	maxBody   int
	flags     func() Flags
	onOutcome func(OutcomeEvent)
	behaviors []string
}

// Flags switch compatibility work off, per contract, per Change or at all.
type Flags struct {
	AllDisabled       bool
	DisabledContracts []string
	DisabledChanges   []string
}

// OutcomeEvent is what happened to one adapted request or response.
type OutcomeEvent struct {
	Contract  string
	Operation string
	Consumer  string
	// Direction is "request", "response" or "outbound".
	Direction string
	// Outcome is "adapted", "refused" or "failed".
	Outcome string
	// Reason says why, when it was not adapted. Never a body or a value.
	Reason  string
	ErrorID string
}

// Options configure a runtime.
type Options struct {
	// Limits bound what one body may cost; zero values take the defaults.
	Limits Limits
	// Identity overrides the program's own identity declaration.
	Identity []Identity
	// MaxBodyBytes is the largest body buffered for a transform; 1 MiB if 0.
	MaxBodyBytes int
	Flags        func() Flags
	OnOutcome    func(OutcomeEvent)
}

// Load decodes a program and returns a runtime for it. A program this engine
// cannot run in full is refused, never run in part.
func Load(programText []byte, options Options) (*Runtime, error) {
	raw, err := Parse(programText)
	if err != nil {
		return nil, programError("the program is not JSON: %v", err)
	}
	program, err := decodeProgram(raw)
	if err != nil {
		return nil, err
	}
	limits := options.Limits
	if limits.MaxMatches == 0 {
		limits.MaxMatches = DefaultLimits.MaxMatches
	}
	if limits.TimeBudget == 0 {
		limits.TimeBudget = DefaultLimits.TimeBudget
	}
	runtime := &Runtime{program: program, limits: limits, maxBody: options.MaxBodyBytes, flags: options.Flags, onOutcome: options.OnOutcome}
	if runtime.maxBody == 0 {
		runtime.maxBody = 1024 * 1024
	}
	if runtime.flags == nil {
		runtime.flags = func() Flags { return Flags{} }
	}
	// Declared once, in invariant.yaml, and compiled into the program; a
	// binding's own list is for tests and migrations off it.
	runtime.identity = options.Identity
	if runtime.identity == nil {
		runtime.identity = program.Identity
	}
	if runtime.identity == nil {
		return nil, errors.New("nothing says how a request names its contract: declare `identity` in invariant.yaml and compile again, or pass one in Options")
	}
	// A configuration naming a contract the program does not have is a
	// mistake to catch at startup, not on the first request to reach it.
	for _, strategy := range runtime.identity {
		var named []string
		switch strategy.Kind {
		case "default":
			named = []string{strategy.Label}
		case "urlPrefix":
			for _, prefix := range strategy.Prefixes {
				named = append(named, prefix[1])
			}
		}
		for _, label := range named {
			if !runtime.Knows(label) {
				return nil, fmt.Errorf("the %s identity strategy names contract %q, which this program does not have. Known: %s", strategy.Kind, label, strings.Join(runtime.knownList(), ", "))
			}
		}
	}
	seen := map[string]bool{}
	for _, label := range program.order {
		for _, flag := range program.Contracts[label].Behaviors {
			if !seen[flag] {
				seen[flag] = true
				runtime.behaviors = append(runtime.behaviors, flag)
			}
		}
	}
	sort.Strings(runtime.behaviors)
	return runtime, nil
}

var (
	httpMethods  = map[string]bool{"get": true, "put": true, "post": true, "delete": true, "options": true, "head": true, "patch": true, "trace": true}
	statusKey    = regexp.MustCompile(`^([1-5]\d\d|[1-5][xX][xX]|default)$`)
	versionText  = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)
	contractBase = regexp.MustCompile(`^(/.*[^/])?$`)
)

// ProgramTooNewError is a program this engine is too old to run, refused
// before anything in it is read.
type ProgramTooNewError struct {
	Needs      string
	CompiledBy string
}

func (e *ProgramTooNewError) Error() string {
	by := ""
	if e.CompiledBy != "" {
		by = "; it was compiled by " + e.CompiledBy
	}
	return "This program needs " + e.Needs + ", and this runtime is " + Version + by +
		". Upgrade the runtime to at least that version, or compile with a CLI no newer than it."
}

// Code is the refusal's stable code.
func (e *ProgramTooNewError) Code() string { return "invariant_program_too_new" }

// compareVersions orders two major.minor.patch versions; a pre-release sorts
// before its release.
func compareVersions(a, b string) int {
	parse := func(version string) ([3]int, string, bool) {
		core, pre, hasPre := strings.Cut(version, "-")
		var parts [3]int
		for index, part := range strings.SplitN(core, ".", 3) {
			parts[index], _ = strconv.Atoi(part)
		}
		return parts, pre, hasPre
	}
	left, leftPre, leftHas := parse(a)
	right, rightPre, rightHas := parse(b)
	for index := 0; index < 3; index++ {
		if left[index] != right[index] {
			if left[index] < right[index] {
				return -1
			}
			return 1
		}
	}
	switch {
	case leftHas == rightHas && leftPre == rightPre:
		return 0
	case !leftHas:
		return 1
	case !rightHas:
		return -1
	case leftPre < rightPre:
		return -1
	}
	return 1
}

// checkVersion says whether this engine can run the program at all, read
// before anything else in it.
func checkVersion(value *Object) error {
	compiledBy, _ := field(value, "compiledBy").(string)
	format, isNumber := field(value, "irVersion").(Number)
	if isNumber {
		if n, err := strconv.ParseFloat(string(format), 64); err == nil && n > ProgramVersion {
			return &ProgramTooNewError{Needs: "program format " + string(format), CompiledBy: compiledBy}
		}
	}
	if format != Number(strconv.Itoa(ProgramVersion)) {
		return programError("Unsupported program format %v; this runtime reads format %d. Compile the program again with a current CLI.", field(value, "irVersion"), ProgramVersion)
	}
	raw, present := value.Get("minRuntime")
	if !present {
		return nil
	}
	minRuntime, isText := raw.(string)
	if !isText || !versionText.MatchString(minRuntime) {
		return programError("program.minRuntime must be a version such as 1.2.3")
	}
	// A feature not yet released asks for a pre-release of the patch after the
	// last release, "-next". The engine built from the same unreleased source
	// implements it; every published one is older and refuses it here.
	if compareVersions(minRuntime, Version) > 0 && minRuntime != nextRelease(Version) {
		return &ProgramTooNewError{Needs: "runtime " + minRuntime, CompiledBy: compiledBy}
	}
	return nil
}

// nextRelease is the version a feature not yet released asks for, as the
// compiler writes it.
func nextRelease(version string) string {
	core, _, _ := strings.Cut(version, "-")
	parts := strings.Split(core, ".")
	for len(parts) < 3 {
		parts = append(parts, "0")
	}
	patch, _ := strconv.Atoi(parts[2])
	return parts[0] + "." + parts[1] + "." + strconv.Itoa(patch+1) + "-next"
}

func decodeIdentity(raw any) ([]Identity, error) {
	if raw == nil {
		return nil, nil
	}
	list, isList := raw.(*Array)
	if !isList || len(list.Items) == 0 {
		return nil, programError("program.identity must list at least one strategy")
	}
	var out []Identity
	for index, entry := range list.Items {
		where := "program.identity[" + itoa(index) + "]"
		value, err := asObject(entry, where)
		if err != nil {
			return nil, err
		}
		kind, _ := field(value, "kind").(string)
		strategy := Identity{Kind: kind}
		switch kind {
		case "header":
			if err := expectKeys(value, []string{"kind", "name"}, where); err != nil {
				return nil, err
			}
			name, err := stringField(value, "name", where)
			if err != nil {
				return nil, err
			}
			// Header names are case-insensitive, and compared lower-cased.
			strategy.Name = strings.ToLower(name)
		case "urlPrefix":
			if err := expectKeys(value, []string{"kind", "map"}, where); err != nil {
				return nil, err
			}
			prefixes, err := asObject(field(value, "map"), where+".map")
			if err != nil {
				return nil, err
			}
			for _, prefix := range prefixes.Keys() {
				label, err := stringField(prefixes, prefix, where+".map")
				if err != nil {
					return nil, err
				}
				strategy.Prefixes = append(strategy.Prefixes, [2]string{prefix, label})
			}
		case "principal":
			if err := expectKeys(value, []string{"kind"}, where); err != nil {
				return nil, err
			}
		case "default":
			if err := expectKeys(value, []string{"kind", "label"}, where); err != nil {
				return nil, err
			}
			if strategy.Label, err = stringField(value, "label", where); err != nil {
				return nil, err
			}
		default:
			return nil, programError("%s.kind is not a strategy this runtime knows", where)
		}
		out = append(out, strategy)
	}
	return out, nil
}

func decodeRoute(raw any, where string) (Route, error) {
	value, err := asObject(raw, where)
	if err != nil {
		return Route{}, err
	}
	if err := expectKeys(value, []string{"from", "to", "c"}, where); err != nil {
		return Route{}, err
	}
	from, err := asObject(field(value, "from"), where+".from")
	if err != nil {
		return Route{}, err
	}
	to, err := asObject(field(value, "to"), where+".to")
	if err != nil {
		return Route{}, err
	}
	route := Route{}
	var fromPath, toPath string
	for _, read := range []struct {
		object *Object
		key    string
		at     string
		into   *string
	}{
		{from, "method", where + ".from", &route.Method},
		{to, "method", where + ".to", &route.ToMethod},
		{from, "path", where + ".from", &fromPath},
		{to, "path", where + ".to", &toPath},
	} {
		if *read.into, err = stringField(read.object, read.key, read.at); err != nil {
			return Route{}, err
		}
	}
	route.Method, route.ToMethod = strings.ToLower(route.Method), strings.ToLower(route.ToMethod)
	for _, method := range []string{route.Method, route.ToMethod} {
		if !httpMethods[method] {
			return Route{}, programError("%s names %s, which is not an HTTP method", where, method)
		}
	}
	route.From, route.To = strings.Split(fromPath, "/"), strings.Split(toPath, "/")
	if route.ChangeID, err = stringField(value, "c", where); err != nil {
		return Route{}, err
	}
	return route, nil
}

func stringList(raw any, where string) ([]string, error) {
	if raw == nil {
		return nil, nil
	}
	list, err := asArray(raw, where)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(list))
	for index, entry := range list {
		if out[index], err = asString(entry, where+"["+itoa(index)+"]"); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func decodeProgram(raw any) (*Program, error) {
	value, err := asObject(raw, "program")
	if err != nil {
		return nil, err
	}
	if err := checkVersion(value); err != nil {
		return nil, err
	}
	if err := expectKeys(value, []string{
		"irVersion", "compiledBy", "minRuntime", "api", "current", "currentLabel",
		"contracts", "blocks", "basePath", "identity",
	}, "program"); err != nil {
		return nil, err
	}
	if compiledBy, present := value.Get("compiledBy"); present {
		if _, isText := compiledBy.(string); !isText {
			return nil, programError("program.compiledBy must be a string")
		}
	}
	program := &Program{Contracts: map[string]*Contract{}}
	if base, present := value.Get("basePath"); present {
		text, isText := base.(string)
		if !isText || !strings.HasPrefix(text, "/") || strings.HasSuffix(text, "/") {
			return nil, programError("program.basePath must be a path such as /v1, without a trailing /")
		}
		program.BasePath = text
	}
	shared, err := decodeBlocks(field(value, "blocks"), "program.blocks", blocks{})
	if err != nil {
		return nil, err
	}
	contracts, err := asObject(field(value, "contracts"), "program.contracts")
	if err != nil {
		return nil, err
	}
	for _, label := range contracts.Keys() {
		where := "program.contracts." + label
		entry, _ := contracts.Get(label)
		decoded, err := decodeContract(entry, where, shared)
		if err != nil {
			return nil, err
		}
		program.Contracts[label] = decoded
		program.order = append(program.order, label)
	}
	if program.Identity, err = decodeIdentity(field(value, "identity")); err != nil {
		return nil, err
	}
	if program.API, err = stringField(value, "api", "program"); err != nil {
		return nil, err
	}
	if program.Current, err = stringField(value, "current", "program"); err != nil {
		return nil, err
	}
	if program.CurrentLabel, err = stringField(value, "currentLabel", "program"); err != nil {
		return nil, err
	}
	return program, nil
}

func decodeContract(raw any, where string, shared blocks) (*Contract, error) {
	contract, err := asObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := expectKeys(contract, []string{
		"label", "routes", "sites", "outbound", "blocks", "behaviors", "retired", "basePath",
	}, where); err != nil {
		return nil, err
	}
	named, err := decodeBlocks(field(contract, "blocks"), where+".blocks", shared)
	if err != nil {
		return nil, err
	}
	decoded := &Contract{Sites: map[string]*Site{}, Outbound: map[string][]*Instr{}, blocks: named}
	if base, present := contract.Get("basePath"); present {
		text, isText := base.(string)
		if !isText || !contractBase.MatchString(text) {
			return nil, programError("%s.basePath must be a path such as /v1, or empty", where)
		}
		decoded.BasePath = &text
	}
	sites, err := asObject(field(contract, "sites"), where+".sites")
	if err != nil {
		return nil, err
	}
	for _, key := range sites.Keys() {
		// Only the method is case-insensitive; a path is not.
		separator := strings.IndexByte(key, ' ')
		if separator <= 0 {
			return nil, programError("%s.sites has a key %q that is not \"method path\"", where, key)
		}
		method, path := strings.ToLower(key[:separator]), key[separator+1:]
		rawSite, _ := sites.Get(key)
		site, err := decodeSite(rawSite, where+".sites."+key, path, named)
		if err != nil {
			return nil, err
		}
		if _, seen := decoded.Sites[method+" "+path]; !seen {
			decoded.siteOrder = append(decoded.siteOrder, method+" "+path)
		}
		decoded.Sites[method+" "+path] = site
	}
	if outbound, present := contract.Get("outbound"); present {
		events, err := asObject(outbound, where+".outbound")
		if err != nil {
			return nil, err
		}
		for _, key := range events.Keys() {
			separator := strings.IndexByte(key, ' ')
			event := key[separator+1:]
			if separator <= 0 || !(strings.HasPrefix(event, "webhook:") || strings.HasPrefix(event, "callback:")) || len(event) == strings.IndexByte(event, ':')+1 {
				return nil, programError("%s.outbound has a key %q that is not \"method webhook:<name>\" or \"method callback:<operation>/<callback>\"", where, key)
			}
			list, _ := events.Get(key)
			instrs, err := decodeBlock(list, where+".outbound."+key, 0, named, false)
			if err != nil {
				return nil, err
			}
			decoded.Outbound[strings.ToLower(key[:separator])+" "+event] = instrs
		}
	}
	if decoded.Label, err = stringField(contract, "label", where); err != nil {
		return nil, err
	}
	routes, err := asArray(field(contract, "routes"), where+".routes")
	if err != nil {
		return nil, err
	}
	for index, entry := range routes {
		route, err := decodeRoute(entry, where+".routes["+itoa(index)+"]")
		if err != nil {
			return nil, err
		}
		decoded.Routes = append(decoded.Routes, route)
	}
	if decoded.Behaviors, err = stringList(field(contract, "behaviors"), where+".behaviors"); err != nil {
		return nil, err
	}
	if retired, present := contract.Get("retired"); present {
		rows, err := asArray(retired, where+".retired")
		if err != nil {
			return nil, err
		}
		for index, entry := range rows {
			at := where + ".retired[" + itoa(index) + "]"
			row, err := asObject(entry, at)
			if err != nil {
				return nil, err
			}
			gone := Retired{}
			if gone.Method, err = stringField(row, "method", at); err != nil {
				return nil, err
			}
			gone.Method = strings.ToLower(gone.Method)
			if gone.Path, err = stringField(row, "path", at); err != nil {
				return nil, err
			}
			if _, present := row.Get("guidance"); present {
				if gone.Guidance, err = stringField(row, "guidance", at); err != nil {
					return nil, err
				}
			}
			if gone.C, err = stringField(row, "c", at); err != nil {
				return nil, err
			}
			if refuse, present := row.Get("refuse"); present {
				if refuse != true {
					return nil, programError("%s.refuse must be true when present", at)
				}
				gone.Refuse = true
			}
			decoded.Retired = append(decoded.Retired, gone)
		}
	}
	return decoded, nil
}

func decodeSite(raw any, where, path string, named blocks) (*Site, error) {
	site, err := asObject(raw, where)
	if err != nil {
		return nil, err
	}
	if err := expectKeys(site, []string{"form", "xml", "request", "envelope", "response", "status"}, where); err != nil {
		return nil, err
	}
	_, hasRequest := site.Get("request")
	_, hasEnvelope := site.Get("envelope")
	if hasRequest && hasEnvelope {
		return nil, programError("%s has both request and envelope; one list keeps the order", where)
	}
	out := &Site{Response: map[string][]*Instr{}, Template: strings.Split(path, "/")}
	if form, present := site.Get("form"); present {
		if out.Form, err = decodeForm(form, where+".form"); err != nil {
			return nil, err
		}
	}
	if xml, present := site.Get("xml"); present {
		if out.XML, err = decodeXMLProgram(xml, where+".xml"); err != nil {
			return nil, err
		}
	}
	if hasEnvelope {
		if out.Envelope, err = decodeEnvelope(field(site, "envelope"), where+".envelope", named); err != nil {
			return nil, err
		}
	}
	if request, present := site.Get("request"); present {
		if out.Request, err = decodeBlock(request, where+".request", 0, named, false); err != nil {
			return nil, err
		}
	}
	if response, present := site.Get("response"); present {
		statuses, err := asObject(response, where+".response")
		if err != nil {
			return nil, err
		}
		for _, status := range statuses.Keys() {
			// As OpenAPI writes them: an exact status, a class such as 2XX, or
			// default for every status nothing more specific names.
			if !statusKey.MatchString(status) {
				return nil, programError("%s.response has an invalid status key %q", where, status)
			}
			key := strings.ToLower(status)
			if _, twice := out.Response[key]; twice {
				return nil, programError("%s.response names %s twice", where, key)
			}
			list, _ := statuses.Get(status)
			if out.Response[key], err = decodeBlock(list, where+".response."+status, 0, named, false); err != nil {
				return nil, err
			}
		}
	}
	if rules, present := site.Get("status"); present {
		if out.Status, err = decodeStatusRules(rules, where+".status"); err != nil {
			return nil, err
		}
	}
	if out.XML != nil {
		// An XML body has no maps: what a map's wildcard would reach there are
		// the elements nothing names, kept whole.
		lists := [][]*Instr{out.Request}
		for _, list := range out.Response {
			lists = append(lists, list)
		}
		if out.Envelope != nil {
			lists = append(lists, out.Envelope.Instrs)
		}
		if readsMapValues(lists...) {
			return nil, programError("%s reads a map's values in an XML body, which has none", where)
		}
	}
	return out, nil
}

func decodeStatusRules(raw any, where string) ([]StatusRule, error) {
	items, err := asArray(raw, where)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, programError("%s must name at least one rule", where)
	}
	out := make([]StatusRule, 0, len(items))
	for index, item := range items {
		at := where + "[" + itoa(index) + "]"
		value, err := asObject(item, at)
		if err != nil {
			return nil, err
		}
		if err := expectKeys(value, []string{"from", "to", "empty", "c"}, at); err != nil {
			return nil, err
		}
		status := func(name string) (int, error) {
			number, ok := field(value, name).(Number)
			code, parseErr := strconv.Atoi(string(number))
			if !ok || parseErr != nil || code < 200 || code > 299 {
				return 0, programError("%s.%s must be a success status, 200 to 299", at, name)
			}
			return code, nil
		}
		rule := StatusRule{}
		if rule.From, err = status("from"); err != nil {
			return nil, err
		}
		if rule.To, err = status("to"); err != nil {
			return nil, err
		}
		if rule.From == rule.To {
			return nil, programError("%s answers %d as itself", at, rule.From)
		}
		if rule.Empty, err = onlyTrue(value, "empty", at); err != nil {
			return nil, err
		}
		// A 204 or a 205 never carries a body, so a rule that would send one
		// with it is a program nobody should have compiled.
		if emptyStatus(rule.To) && !rule.Empty {
			return nil, programError("%s answers %d, which carries no body, so it must be empty", at, rule.To)
		}
		if rule.C, err = stringField(value, "c", at); err != nil {
			return nil, err
		}
		out = append(out, rule)
	}
	return out, nil
}

// ErrNoSite is a request with no compiled work.
var ErrNoSite = errors.New("no compiled work for this operation")

// TransformRequest rewrites a request body for a caller on contract, from
// their shape into the current one.
func (r *Runtime) TransformRequest(contract, siteKey string, body []byte) ([]byte, *Result, error) {
	site, err := r.site(contract, siteKey)
	if err != nil {
		return nil, nil, err
	}
	return r.run(site.Request, body)
}

// TransformEnvelope rewrites a whole request for a caller on contract, where
// the site's program reaches its parameters: its path, query string, headers
// and, where the program reads it, its body. request.Path is the routed path
// without any base path. Nothing the program does not name is changed, down
// to the bytes and order of an untouched query string.
func (r *Runtime) TransformEnvelope(contract, siteKey string, request EnvelopeRequest) (EnvelopeRequest, *Result, error) {
	site, err := r.site(contract, siteKey)
	if err != nil {
		return request, nil, err
	}
	return runEnvelope(site, request, r.limits)
}

// TransformRequestForm rewrites a form-encoded request body for a caller on
// contract: the fields the site's program names are decoded, transformed and
// written back, and every other pair of the form is passed on as it came.
func (r *Runtime) TransformRequestForm(contract, siteKey, text string) (string, *Result, error) {
	site, err := r.site(contract, siteKey)
	if err != nil {
		return text, nil, err
	}
	if site.Form == nil || len(site.Request) == 0 {
		return text, &Result{Applied: map[string]int{}, Folded: map[string]bool{}}, nil
	}
	roots := formRoots(site.Request, 0)
	tree, err := openForm(site.Form, roots, text)
	if err != nil {
		return text, nil, err
	}
	result, err := Execute(tree, site.Request, r.limits)
	if err != nil {
		return text, nil, err
	}
	out, err := closeForm(site.Form, roots, text, tree, site.Request, 0)
	if err != nil {
		return text, nil, err
	}
	return out, result, nil
}

// TransformRequestXML rewrites an XML request body for a caller on
// contract: the places the site's program names are decoded, transformed and
// written back, and every element it does not name is passed on as it came.
func (r *Runtime) TransformRequestXML(contract, siteKey, text, contentType string) (string, *Result, error) {
	site, err := r.site(contract, siteKey)
	if err != nil {
		return text, nil, err
	}
	if site.XML == nil || site.XML.Request == nil || len(site.Request) == 0 {
		return text, &Result{Applied: map[string]int{}, Folded: map[string]bool{}}, nil
	}
	return runXML(site.Request, site.XML.Request, text, contentType, r.limits)
}

func (r *Runtime) site(contract, siteKey string) (*Site, error) {
	decoded, ok := r.program.Contracts[contract]
	if !ok {
		return nil, ErrNoSite
	}
	site, ok := decoded.Sites[siteKey]
	if !ok {
		return nil, ErrNoSite
	}
	return site, nil
}

func (r *Runtime) run(instrs []*Instr, body []byte) ([]byte, *Result, error) {
	if len(instrs) == 0 {
		return body, &Result{Applied: map[string]int{}, Folded: map[string]bool{}}, nil
	}
	root, err := parseBody(body)
	if err != nil {
		return nil, nil, err
	}
	result, err := Execute(root, instrs, r.limits)
	if err != nil {
		return nil, nil, err
	}
	out, err := Marshal(root)
	return out, result, err
}

// parseBody parses a body, a failure being a SyntaxError unless the body was
// too deep, which is refused as too large.
func parseBody(body []byte) (any, error) {
	root, err := Parse(body)
	if err != nil && !errors.Is(err, ErrTooDeep) {
		return nil, &SyntaxError{Message: "The body is not valid JSON: " + err.Error()}
	}
	return root, err
}
