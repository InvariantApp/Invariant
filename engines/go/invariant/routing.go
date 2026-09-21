package invariant

// Which handler a request is for, which contract its caller speaks, and the
// work compiled for it: the two stages every binding runs, ported from the
// reference runtime so a Go service answers exactly as a Node one does.

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

// Header names the runtime reads and writes.
const (
	// ContractHintHeader is how stage one tells stage two what it concluded.
	ContractHintHeader = "X-Invariant-Contract-Hint"
	// ContractResponseHeader names the contract an adapted answer is shaped for.
	ContractResponseHeader = "Invariant-Contract"
	// ErrorIDHeader carries a refusal's or failure's id.
	ErrorIDHeader = "Invariant-Error-Id"
	// FoldedHeader names the fields a fold substituted, only when one fired.
	FoldedHeader   = "Invariant-Folded"
	internalPrefix = "x-invariant-"
)

// Error codes a caller or an operator can search for, as the reference has them.
const (
	CodeContractUnsupported     = "invariant_contract_unsupported"
	CodeEndpointRetired         = "invariant_endpoint_retired"
	CodeBodyTooLarge            = "invariant_body_too_large"
	CodeRequestNotTranslatable  = "invariant_request_not_translatable"
	CodeResponseNotTranslatable = "invariant_response_not_translatable"
	CodeEncodingUnsupported     = "invariant_encoding_unsupported"
)

// ContractResolution is a contract and how it was learned.
type ContractResolution struct {
	Label string
	// Source is "header", "urlPrefix", "principal", "default" or "route".
	Source string
}

// RouteDecision is what stage one concludes.
type RouteDecision struct {
	// Path is the path the canonical handler should see.
	Path string
	// Method is the method it should see, uppercase.
	Method    string
	Hint      *ContractResolution
	Rewritten bool
}

// UnsupportedContractError is a contract that cannot be served: unknown, or
// switched off.
type UnsupportedContractError struct {
	Contract string
	Message  string
	errorID  string
}

func (e *UnsupportedContractError) Error() string { return e.Message }

func unsupported(contract, reason string) *UnsupportedContractError {
	return &UnsupportedContractError{Contract: contract, Message: "Contract " + contract + " cannot be served right now: " + reason}
}

// unknownContract is worded apart from a switched-off contract on purpose: a
// caller told "cannot be served right now" about a typo would wait for
// something that is never coming back.
func unknownContract(contract string, known []string) *UnsupportedContractError {
	list := known[0]
	if len(known) > 1 {
		list = strings.Join(known[:len(known)-1], ", ") + " and " + known[len(known)-1]
	}
	return &UnsupportedContractError{Contract: contract, Message: "No contract is called \"" + contract + "\". This API serves " + list + "."}
}

// RetiredEndpointError is an endpoint the caller's contract had and the
// current one does not.
type RetiredEndpointError struct {
	Contract string
	ChangeID string
	Guidance string
	Message  string
	errorID  string
}

func (e *RetiredEndpointError) Error() string { return e.Message }

func retiredError(contract, method, path string, gone Retired) *RetiredEndpointError {
	tail := ". Nothing replaced it."
	if gone.Guidance != "" {
		tail = ". " + gone.Guidance
	}
	return &RetiredEndpointError{
		Contract: contract, ChangeID: gone.C, Guidance: gone.Guidance,
		Message: strings.ToUpper(method) + " " + path + " was retired after contract " + contract + tail,
	}
}

// BodyTooLargeError is a body past the limit for a transformed operation.
type BodyTooLargeError struct {
	Limit   int
	errorID string
}

func (e *BodyTooLargeError) Error() string {
	return "Request body exceeds the " + itoa(e.Limit) + " byte limit for a transformed operation"
}

// UnsupportedEncodingError is a Content-Encoding this engine cannot decode.
type UnsupportedEncodingError struct {
	Encoding string
	errorID  string
}

func (e *UnsupportedEncodingError) Error() string {
	return "The body is encoded as \"" + e.Encoding + "\", which cannot be decoded here, so it cannot be translated."
}

// NewErrorID is an id for one refusal or failure, so what a caller quotes can
// be found in the provider's own logs.
func NewErrorID() string {
	var bytes [12]byte
	_, _ = rand.Read(bytes[:])
	return "err_" + hex.EncodeToString(bytes[:])
}

// ErrorIDOf is the id an error was given when it happened, giving it one if
// it has none.
func ErrorIDOf(err error) string {
	var slot *string
	var (
		contract  *UnsupportedContractError
		retired   *RetiredEndpointError
		large     *BodyTooLargeError
		encoding  *UnsupportedEncodingError
		transform *TransformError
	)
	switch {
	case errors.As(err, &contract):
		slot = &contract.errorID
	case errors.As(err, &retired):
		slot = &retired.errorID
	case errors.As(err, &large):
		slot = &large.errorID
	case errors.As(err, &encoding):
		slot = &encoding.errorID
	case errors.As(err, &transform):
		slot = &transform.errorID
	default:
		return ""
	}
	if *slot == "" {
		*slot = NewErrorID()
	}
	return *slot
}

// Knows says whether a contract label is one this program serves.
func (r *Runtime) Knows(label string) bool {
	if label == r.program.CurrentLabel {
		return true
	}
	_, ok := r.program.Contracts[label]
	return ok
}

// CurrentLabel is the current contract's label.
func (r *Runtime) CurrentLabel() string { return r.program.CurrentLabel }

// MaxBodyBytes is the largest body buffered for a transform.
func (r *Runtime) MaxBodyBytes() int { return r.maxBody }

func (r *Runtime) knownList() []string {
	seen := map[string]bool{r.program.CurrentLabel: true}
	labels := []string{r.program.CurrentLabel}
	for _, label := range r.program.order {
		if !seen[label] {
			seen[label] = true
			labels = append(labels, label)
		}
	}
	sortStrings(labels)
	return labels
}

func (r *Runtime) outcome(event OutcomeEvent) {
	if r.onOutcome != nil {
		r.onOutcome(event)
	}
}

// refused reports a caller turned away before any operation was chosen.
func (r *Runtime) refused(err *UnsupportedContractError, path string) *UnsupportedContractError {
	r.outcome(OutcomeEvent{Contract: err.Contract, Operation: path, Direction: "request", Outcome: "refused", Reason: "UnsupportedContractError", ErrorID: ErrorIDOf(err)})
	return err
}

// SanitizeHeaders strips every inbound header in the runtime's internal
// namespace, which a caller must never be able to supply.
func SanitizeHeaders(headers http.Header) {
	for name := range headers {
		if strings.HasPrefix(strings.ToLower(name), internalPrefix) {
			delete(headers, name)
		}
	}
}

// HintFrom is whatever the pre-authentication signals say about the caller's
// contract. A named contract that does not exist is refused, never ignored.
func (r *Runtime) HintFrom(headers http.Header, path string) (*ContractResolution, error) {
	for _, strategy := range r.identity {
		switch strategy.Kind {
		case "header":
			if value := headers.Get(strategy.Name); value != "" {
				if !r.Knows(value) {
					return nil, r.refused(unknownContract(value, r.knownList()), path)
				}
				return &ContractResolution{Label: value, Source: "header"}, nil
			}
		case "urlPrefix":
			for _, prefix := range strategy.Prefixes {
				if strings.HasPrefix(path, prefix[0]) && r.Knows(prefix[1]) {
					return &ContractResolution{Label: prefix[1], Source: "urlPrefix"}, nil
				}
			}
		}
	}
	return nil, nil
}

// local is a request's path as the contract writes it, with the base path
// taken off; false for a path outside it, which is never touched.
func (r *Runtime) local(path string) (string, bool) {
	base := r.program.BasePath
	switch {
	case base == "":
		return path, true
	case path == base:
		return "/", true
	case strings.HasPrefix(path, base+"/"):
		return path[len(base):], true
	}
	return "", false
}

// fromOlderBase moves a request under a base path an older contract was
// served under to the current one.
func (r *Runtime) fromOlderBase(full string, hint *ContractResolution) (string, *ContractResolution, bool) {
	current := r.program.BasePath
	if current != "" && (full == current || strings.HasPrefix(full, current+"/")) {
		return "", nil, false
	}
	bestBase, found := "", false
	var labels []string
	for _, label := range r.program.order {
		contract := r.program.Contracts[label]
		if contract.BasePath == nil || *contract.BasePath == current {
			continue
		}
		base := *contract.BasePath
		if hint != nil && hint.Label != contract.Label {
			continue
		}
		if !(base == "" || full == base || strings.HasPrefix(full, base+"/")) {
			continue
		}
		// The longest base that fits is the one the caller used.
		switch {
		case !found || len(base) > len(bestBase):
			bestBase, found, labels = base, true, []string{contract.Label}
		case base == bestBase:
			labels = append(labels, contract.Label)
		}
	}
	if !found {
		return "", nil, false
	}
	path := current + full[len(bestBase):]
	if path == "" {
		path = "/"
	}
	if hint == nil && len(labels) == 1 {
		hint = &ContractResolution{Label: labels[0], Source: "route"}
	}
	return path, hint, true
}

// Route is stage one: the path and method the canonical handler should see.
// When the caller declared a contract, that contract's route table is used;
// otherwise the path can still identify an old endpoint, but only if every
// contract that knows it agrees on where it went.
func (r *Runtime) Route(method, full string, headers http.Header) (RouteDecision, error) {
	hint, err := r.HintFrom(headers, full)
	if err != nil {
		return RouteDecision{}, err
	}
	moved := false
	if path, older, ok := r.fromOlderBase(full, hint); ok {
		moved = path != full
		full, hint = path, older
	}
	asSent := strings.ToUpper(method)
	path, inside := r.local(full)
	if !inside {
		return RouteDecision{Path: full, Method: asSent, Hint: hint, Rewritten: moved}, nil
	}
	var candidates []*Contract
	if hint != nil {
		if contract, ok := r.program.Contracts[hint.Label]; ok {
			candidates = []*Contract{contract}
		}
	} else {
		for _, label := range r.program.order {
			candidates = append(candidates, r.program.Contracts[label])
		}
	}
	type match struct{ label, method, path string }
	matches := map[string]match{}
	lower := strings.ToLower(method)
	for _, contract := range candidates {
		for _, rule := range contract.Routes {
			if rule.Method != lower {
				continue
			}
			params, ok := matchTemplate(rule.From, path)
			if !ok {
				continue
			}
			target := fillTemplate(rule.To, params)
			matches[rule.ToMethod+" "+target] = match{contract.Label, rule.ToMethod, target}
		}
	}
	if len(matches) != 1 {
		return RouteDecision{Path: full, Method: asSent, Hint: hint, Rewritten: moved}, nil
	}
	var origin match
	for _, only := range matches {
		origin = only
	}
	changedMethod := origin.method != lower
	decision := RouteDecision{
		Path:      r.program.BasePath + origin.path,
		Method:    asSent,
		Hint:      hint,
		Rewritten: moved || changedMethod || origin.path != path,
	}
	if changedMethod {
		decision.Method = strings.ToUpper(origin.method)
	}
	if hint == nil {
		decision.Hint = &ContractResolution{Label: origin.label, Source: "route"}
	}
	return decision, nil
}

// Resolve is stage two: which contract this request is served under. pinned
// is the contract pinned to the authenticated caller's account, or "".
func (r *Runtime) Resolve(headers http.Header, path, pinned string) (ContractResolution, error) {
	if hinted := headers.Get(ContractHintHeader); hinted != "" && r.Knows(hinted) {
		return ContractResolution{Label: hinted, Source: "header"}, nil
	}
	direct, err := r.HintFrom(headers, path)
	if err != nil {
		return ContractResolution{}, err
	}
	if direct != nil {
		return *direct, nil
	}
	for _, strategy := range r.identity {
		if strategy.Kind == "principal" && pinned != "" {
			if !r.Knows(pinned) {
				return ContractResolution{}, r.refused(unsupported(pinned, "the account is pinned to an unknown contract"), path)
			}
			return ContractResolution{Label: pinned, Source: "principal"}, nil
		}
		if strategy.Kind == "default" {
			return ContractResolution{Label: strategy.Label, Source: "default"}, nil
		}
	}
	return ContractResolution{Label: r.program.CurrentLabel, Source: "default"}, nil
}

func (r *Runtime) retiredIn(contract *Contract, method, path string) (Retired, bool) {
	lower := strings.ToLower(method)
	for _, gone := range contract.Retired {
		if gone.Method != lower {
			continue
		}
		if _, ok := matchTemplate(strings.Split(gone.Path, "/"), path); ok {
			return gone, true
		}
	}
	return Retired{}, false
}

// RetiredFor is an operation retired after this contract that is still
// passed on to the provider, and what to tell the caller if the provider
// answers that it is gone.
func (r *Runtime) RetiredFor(label, method, full string) *RetiredEndpointError {
	if label == r.program.CurrentLabel {
		return nil
	}
	path, inside := r.local(full)
	contract, ok := r.program.Contracts[label]
	if !inside || !ok {
		return nil
	}
	gone, found := r.retiredIn(contract, method, path)
	if !found || gone.Refuse {
		return nil
	}
	return retiredError(label, method, full, gone)
}

// SiteFor is the compiled work for a request, or nil. Nil is the common case
// and the important one: a caller on the current contract, or on an
// operation that never changed, costs a map lookup and no body is read.
func (r *Runtime) SiteFor(label, method, full, operation, consumer string) (*Site, error) {
	// A HEAD is answered as its GET would be, headers and all.
	if strings.EqualFold(method, "HEAD") {
		method = "get"
	}
	site, err := r.siteFor(label, method, full)
	var contract *UnsupportedContractError
	if errors.As(err, &contract) {
		// Counted, because a kill switch left on by accident looks like
		// silence from exactly the consumers it is refusing.
		if operation == "" {
			operation = strings.ToLower(method) + " " + full
		}
		r.outcome(OutcomeEvent{Contract: label, Operation: operation, Consumer: consumer, Direction: "request", Outcome: "refused", Reason: "UnsupportedContractError", ErrorID: ErrorIDOf(err)})
	}
	return site, err
}

func (r *Runtime) siteFor(label, method, full string) (*Site, error) {
	if label == r.program.CurrentLabel {
		return nil, nil
	}
	path, inside := r.local(full)
	if !inside {
		return nil, nil
	}
	flags := r.flags()
	contract, ok := r.program.Contracts[label]
	if !ok {
		return nil, unsupported(label, "no compiled program for this contract")
	}
	// An endpoint refused outright is gone whatever else is configured.
	if gone, found := r.retiredIn(contract, method, path); found && gone.Refuse {
		return nil, retiredError(label, method, full, gone)
	}
	if flags.AllDisabled {
		return nil, unsupported(label, "compatibility is switched off")
	}
	for _, off := range flags.DisabledContracts {
		if off == label {
			return nil, unsupported(label, "this contract is switched off")
		}
	}
	site := findSite(contract, method, path)
	if site == nil {
		return nil, nil
	}
	if len(flags.DisabledChanges) > 0 {
		referenced := map[string]bool{}
		changesIn(site.Request, referenced, map[*Block]bool{})
		if site.Envelope != nil {
			changesIn(site.Envelope.Instrs, referenced, map[*Block]bool{})
		}
		for _, list := range site.Response {
			changesIn(list, referenced, map[*Block]bool{})
		}
		for _, change := range flags.DisabledChanges {
			// Skipping a switched-off instruction would hand back a body in
			// the wrong shape, which is worse than refusing the request.
			if referenced[change] {
				return nil, unsupported(label, "change "+change+" is switched off")
			}
		}
	}
	return site, nil
}

// changesIn is every Change a list of instructions can run, through the
// blocks it nests and the blocks it calls.
func changesIn(instrs []*Instr, into map[string]bool, entered map[*Block]bool) {
	for _, instr := range instrs {
		into[instr.C] = true
		switch instr.K {
		case "within", "has", "is":
			changesIn(instr.Block, into, entered)
		case "switch":
			for _, block := range instr.Cases {
				changesIn(block, into, entered)
			}
		case "call":
			if !entered[instr.Target] {
				entered[instr.Target] = true
				changesIn(instr.Target.Instrs, into, entered)
			}
		}
	}
}

// findSite is the compiled site for a concrete request, found by template.
func findSite(contract *Contract, method, path string) *Site {
	lower := strings.ToLower(method)
	if direct, ok := contract.Sites[lower+" "+path]; ok {
		return direct
	}
	for _, key := range contract.siteOrder {
		separator := strings.IndexByte(key, ' ')
		if key[:separator] != lower {
			continue
		}
		if _, ok := matchTemplate(strings.Split(key[separator+1:], "/"), path); ok {
			return contract.Sites[key]
		}
	}
	return nil
}

// fillTemplate writes values into a template's parameters, in order.
func fillTemplate(template, params []string) string {
	next := 0
	segments := make([]string, len(template))
	for index, segment := range template {
		segments[index] = templateParameter.ReplaceAllStringFunc(segment, func(string) string {
			value := ""
			if next < len(params) {
				value = params[next]
			}
			next++
			return value
		})
	}
	return strings.Join(segments, "/")
}

// ReadsRequestBody says whether adapting a request means reading its body.
func (r *Runtime) ReadsRequestBody(site *Site) bool {
	return len(site.Request) > 0 || (site.Envelope != nil && site.Envelope.Body)
}

// RewritesPathParameters says whether some program converts a path
// parameter, so the path itself can change.
func (r *Runtime) RewritesPathParameters() bool {
	for _, contract := range r.program.Contracts {
		for _, site := range contract.Sites {
			if site.Envelope == nil {
				continue
			}
			for _, instr := range site.Envelope.Instrs {
				paths := touchedPaths(instr, nil)
				if len(paths) > 0 && len(paths[0]) > 0 && paths[0][0] == "@path" {
					return true
				}
			}
		}
	}
	return false
}

// VaryOn are the request headers that choose a contract, which every
// response varies on.
func (r *Runtime) VaryOn() []string {
	var names []string
	for _, strategy := range r.identity {
		if strategy.Kind == "header" {
			names = append(names, strategy.Name)
		}
	}
	return names
}

// statusKeys are the keys a response status is looked up by, most specific
// first, as OpenAPI orders them.
func statusKeys(status int) []string {
	return []string{itoa(status), itoa(status/100) + "xx", "default"}
}

// RespondsTo says whether this status has compiled response work, so the
// body must be read.
func (r *Runtime) RespondsTo(site *Site, status int) bool {
	for _, key := range statusKeys(status) {
		if len(site.Response[key]) > 0 {
			return true
		}
	}
	return false
}

// ConditionalHeaders are the request's conditional headers as the handler
// should compare them, on a site whose answers are adapted.
func (r *Runtime) ConditionalHeaders(headers http.Header, contract string, site *Site) http.Header {
	if contract == r.program.CurrentLabel || site == nil {
		return headers
	}
	return UnmarkConditionals(headers, contract)
}

// Transformed is a transformed body, and where a value was folded.
type Transformed struct {
	Body   []byte
	Folded []string
}

// reporting runs a transform and reports how it ended.
func (r *Runtime) reporting(direction, contract, operation, consumer string, run func() error) error {
	err := run()
	if r.onOutcome == nil {
		return err
	}
	event := OutcomeEvent{Contract: contract, Operation: operation, Consumer: consumer, Direction: direction, Outcome: "adapted"}
	if err != nil {
		event.Outcome = "failed"
		if direction == "request" {
			event.Outcome = "refused"
		}
		event.Reason = errorName(err)
		event.ErrorID = ErrorIDOf(err)
	}
	r.outcome(event)
	return err
}

func errorName(err error) string {
	var (
		transform *TransformError
		large     *BodyTooLargeError
		encoding  *UnsupportedEncodingError
	)
	switch {
	case errors.As(err, &transform):
		return "TransformError"
	case errors.As(err, &large):
		return "BodyTooLargeError"
	case errors.As(err, &encoding):
		return "UnsupportedEncodingError"
	}
	return "Error"
}

// TransformResponseBody rewrites a response body for a caller on contract.
func (r *Runtime) TransformResponseBody(site *Site, status int, body []byte, contract, operation, consumer string) (Transformed, error) {
	var instrs []*Instr
	for _, key := range statusKeys(status) {
		if list, ok := site.Response[key]; ok {
			instrs = list
			break
		}
	}
	if instrs == nil {
		return Transformed{Body: body}, nil
	}
	var out Transformed
	err := r.reporting("response", contract, operation, consumer, func() error {
		if len(body) > r.maxBody {
			return &BodyTooLargeError{Limit: r.maxBody}
		}
		transformed, result, err := r.run(instrs, body)
		if err != nil {
			return err
		}
		out.Body = transformed
		for path := range result.Folded {
			out.Folded = append(out.Folded, path)
		}
		sortStrings(out.Folded)
		return nil
	})
	return out, err
}

// AdaptRequestBody rewrites a request body, JSON or form, for a caller on
// contract. A site with an envelope is adapted with AdaptEnvelope instead.
func (r *Runtime) AdaptRequestBody(site *Site, body []byte, form bool, contract, operation, consumer string) ([]byte, error) {
	var out []byte
	err := r.reporting("request", contract, operation, consumer, func() error {
		if len(body) > r.maxBody {
			return &BodyTooLargeError{Limit: r.maxBody}
		}
		if form {
			if site.Form == nil || len(site.Request) == 0 {
				out = body
				return nil
			}
			roots := formRoots(site.Request, 0)
			tree, err := openForm(site.Form, roots, string(body))
			if err != nil {
				return err
			}
			if _, err := Execute(tree, site.Request, r.limits); err != nil {
				return err
			}
			text, err := closeForm(site.Form, roots, string(body), tree, site.Request, 0)
			out = []byte(text)
			return err
		}
		transformed, _, err := r.run(site.Request, body)
		out = transformed
		return err
	})
	return out, err
}

// AdaptEnvelope rewrites a whole request whose program reaches its
// parameters. request.Path is the routed path, base path included.
func (r *Runtime) AdaptEnvelope(site *Site, request EnvelopeRequest, contract, operation, consumer string) (EnvelopeRequest, error) {
	local, inside := r.local(request.Path)
	if site.Envelope == nil || len(site.Envelope.Instrs) == 0 || !inside {
		return request, nil
	}
	out := request
	err := r.reporting("request", contract, operation, consumer, func() error {
		if request.Body != nil && len(*request.Body) > r.maxBody {
			return &BodyTooLargeError{Limit: r.maxBody}
		}
		opened := request
		opened.Path = local
		closed, _, err := runEnvelope(site, opened, r.limits)
		if err != nil {
			return err
		}
		closed.Path = r.program.BasePath + closed.Path
		out = closed
		return nil
	})
	return out, err
}

// ShapedError is a refusal in the provider's own error shape.
type ShapedError struct {
	Body    any
	Status  int
	ErrorID string
}

// ErrorShaper writes refusals in the provider's own error shape.
type ErrorShaper struct {
	BadRequest  func(message, code, errorID string) ShapedError
	ServerError func(message, code, errorID string) ShapedError
	Gone        func(message, code, errorID string) ShapedError
}

func defaultShape(kind string, status int) func(message, code, errorID string) ShapedError {
	return func(message, code, _ string) ShapedError {
		return ShapedError{Status: status, Body: map[string]any{"error": map[string]any{"type": kind, "message": message, "code": code}}}
	}
}

// DefaultErrorShaper answers as the reference runtime's default does.
var DefaultErrorShaper = ErrorShaper{
	BadRequest:  defaultShape("invalid_request_error", 400),
	ServerError: defaultShape("api_error", 502),
	Gone:        defaultShape("invalid_request_error", 410),
}

func (s ErrorShaper) withDefaults() ErrorShaper {
	if s.BadRequest == nil {
		s.BadRequest = DefaultErrorShaper.BadRequest
	}
	if s.ServerError == nil {
		s.ServerError = DefaultErrorShaper.ServerError
	}
	if s.Gone == nil {
		s.Gone = DefaultErrorShaper.Gone
	}
	return s
}

// RequestFailure is what a caller is told when their request could not be
// translated, or false for an error that is not a translation failure.
func RequestFailure(shaper ErrorShaper, err error) (ShapedError, bool) {
	shaper = shaper.withDefaults()
	var (
		large     *BodyTooLargeError
		encoding  *UnsupportedEncodingError
		transform *TransformError
	)
	switch {
	case errors.As(err, &large), errors.As(err, &transform) && (transform.Kind == "matches" || transform.Kind == "time"), errors.Is(err, ErrTooDeep), errors.Is(err, ErrFormTooDeep):
		id := ErrorIDOf(err)
		shaped := shaper.BadRequest(err.Error(), CodeBodyTooLarge, id)
		shaped.Status, shaped.ErrorID = 413, id
		return shaped, true
	case errors.As(err, &encoding):
		id := ErrorIDOf(err)
		shaped := shaper.BadRequest(err.Error(), CodeEncodingUnsupported, id)
		shaped.Status, shaped.ErrorID = 415, id
		return shaped, true
	case errors.As(err, &transform), isSyntaxError(err):
		id := ErrorIDOf(err)
		shaped := shaper.BadRequest(err.Error(), CodeRequestNotTranslatable, id)
		shaped.ErrorID = id
		if id == "" {
			shaped.ErrorID = NewErrorID()
		}
		return shaped, true
	}
	return ShapedError{}, false
}

// ResponseFailure is what a caller is told when the answer could not be
// translated back: never the body in a shape their contract does not speak.
func ResponseFailure(shaper ErrorShaper, err error) (ShapedError, bool) {
	shaper = shaper.withDefaults()
	var (
		large     *BodyTooLargeError
		encoding  *UnsupportedEncodingError
		transform *TransformError
	)
	if errors.As(err, &transform) || errors.As(err, &large) || errors.As(err, &encoding) || isSyntaxError(err) || errors.Is(err, ErrTooDeep) {
		id := ErrorIDOf(err)
		if id == "" {
			id = NewErrorID()
		}
		shaped := shaper.ServerError("The response could not be expressed in the contract this integration uses.", CodeResponseNotTranslatable, id)
		shaped.ErrorID = id
		return shaped, true
	}
	return ShapedError{}, false
}

// ContractFailure is what a caller is told when stage one or two refuses
// them, or false for any other error.
func ContractFailure(shaper ErrorShaper, err error) (ShapedError, bool) {
	shaper = shaper.withDefaults()
	var (
		contract *UnsupportedContractError
		retired  *RetiredEndpointError
	)
	switch {
	case errors.As(err, &contract):
		id := ErrorIDOf(err)
		shaped := shaper.BadRequest(err.Error(), CodeContractUnsupported, id)
		shaped.ErrorID = id
		return shaped, true
	case errors.As(err, &retired):
		id := ErrorIDOf(err)
		shaped := shaper.Gone(err.Error(), CodeEndpointRetired, id)
		shaped.ErrorID = id
		return shaped, true
	}
	return ShapedError{}, false
}

// SyntaxError is a body that is not the JSON its type says it is.
type SyntaxError struct{ Message string }

func (e *SyntaxError) Error() string { return e.Message }

func isSyntaxError(err error) bool {
	var syntax *SyntaxError
	return errors.As(err, &syntax)
}

// IsJSONMediaType says whether a body of this type is one a program describes.
func IsJSONMediaType(contentType string) bool {
	media, _, _ := strings.Cut(contentType, ";")
	media = strings.ToLower(strings.TrimSpace(media))
	return media == "application/json" || strings.HasSuffix(media, "+json")
}

// IsFormMediaType says whether a body is form-encoded.
func IsFormMediaType(contentType string) bool {
	media, _, _ := strings.Cut(contentType, ";")
	return strings.ToLower(strings.TrimSpace(media)) == "application/x-www-form-urlencoded"
}

var entityTag = regexp.MustCompile(`^(W/)?"([^"]*)"$`)

// etagMark separates a handler's entity tag from the contract it was adapted
// for: legal inside an entity tag, and not in a contract label.
const etagMark = "~"

// MarkEtag is the entity tag a response adapted for contract carries: the
// handler's, marked with the contract, or "" when it cannot be read.
func MarkEtag(etag, contract string) string {
	match := entityTag.FindStringSubmatch(strings.TrimSpace(etag))
	if match == nil {
		return ""
	}
	return match[1] + `"` + match[2] + etagMark + contract + `"`
}

// noMatch is an entity tag no handler issued.
const noMatch = `"~"`

// UnmarkConditionals are conditional request headers as the handler should
// compare them for a caller on contract: this contract's marks taken off,
// and tags naming another contract's bytes made unable to match.
func UnmarkConditionals(headers http.Header, contract string) http.Header {
	suffix := etagMark + contract + `"`
	var out http.Header
	for _, name := range []string{"If-None-Match", "If-Match"} {
		values, present := headers[name]
		if !present {
			continue
		}
		value := strings.Join(values, ", ")
		var kept []string
		seen := map[string]bool{}
		for _, tag := range strings.Split(value, ",") {
			tag = strings.TrimSpace(tag)
			if tag == "" {
				continue
			}
			switch {
			case tag == "*":
			case strings.HasSuffix(tag, suffix):
				tag = tag[:len(tag)-len(suffix)] + `"`
			case name == "If-Match":
				tag = noMatch
			default:
				continue
			}
			if !seen[tag] {
				seen[tag] = true
				kept = append(kept, tag)
			}
		}
		next := strings.Join(kept, ", ")
		if next == value {
			continue
		}
		if out == nil {
			out = headers.Clone()
		}
		if next == "" {
			out.Del(name)
		} else {
			out.Set(name, next)
		}
	}
	if out == nil {
		return headers
	}
	return out
}

// AppendVary adds header names to Vary, once each.
func AppendVary(headers http.Header, names []string) {
	if len(names) == 0 {
		return
	}
	current := strings.Join(headers.Values("Vary"), ", ")
	if strings.TrimSpace(current) == "*" {
		return
	}
	held := map[string]bool{}
	for _, name := range strings.Split(current, ",") {
		if name = strings.ToLower(strings.TrimSpace(name)); name != "" {
			held[name] = true
		}
	}
	var parts []string
	if current != "" {
		parts = append(parts, current)
	}
	added := false
	for _, name := range names {
		if !held[strings.ToLower(name)] {
			parts = append(parts, name)
			added = true
		}
	}
	if added {
		headers.Set("Vary", strings.Join(parts, ", "))
	}
}

func sortStrings(values []string) { sort.Strings(values) }

// AdaptOutbound is a payload the provider sends of its own accord, a webhook
// or a callback, in the shape a subscriber on contract expects. event names
// it as the contract does: "webhook:<name>" or "callback:<operation>/<callback>".
// Adapt before signing: a subscriber verifies the signature over the bytes it
// receives, so a payload signed and then adapted fails for every old one.
//
// A subscriber on the current contract, or an event nothing changed, gets the
// payload as it is. A contract or a Change switched off refuses rather than
// send a shape the subscriber was never promised.
func (r *Runtime) AdaptOutbound(contract, event string, body []byte, method, consumer string) (Transformed, error) {
	if contract == r.program.CurrentLabel {
		return Transformed{Body: body}, nil
	}
	program, ok := r.program.Contracts[contract]
	if !ok {
		return Transformed{}, unsupported(contract, "no compiled program for this contract")
	}
	flags := r.flags()
	if flags.AllDisabled {
		return Transformed{}, unsupported(contract, "compatibility is switched off")
	}
	for _, off := range flags.DisabledContracts {
		if off == contract {
			return Transformed{}, unsupported(contract, "this contract is switched off")
		}
	}
	if method == "" {
		method = "post"
	}
	instrs, found := program.Outbound[strings.ToLower(method)+" "+event]
	if !found {
		return Transformed{Body: body}, nil
	}
	referenced := map[string]bool{}
	changesIn(instrs, referenced, map[*Block]bool{})
	for _, change := range flags.DisabledChanges {
		if referenced[change] {
			return Transformed{}, unsupported(contract, "change "+change+" is switched off")
		}
	}
	var out Transformed
	err := r.reporting("outbound", contract, event, consumer, func() error {
		if len(body) > r.maxBody {
			return &BodyTooLargeError{Limit: r.maxBody}
		}
		transformed, result, err := r.run(instrs, body)
		if err != nil {
			return err
		}
		out.Body = transformed
		for path := range result.Folded {
			out.Folded = append(out.Folded, path)
		}
		sortStrings(out.Folded)
		return nil
	})
	return out, err
}
