// Package nethttp puts the Invariant runtime in front of any net/http handler.
//
// Every Go router in common use (the standard mux, chi, gorilla/mux, echo and
// gin through their http.Handler adapters) ends in an http.Handler, so
// wrapping that one handler serves all of them with one piece of code, held
// to the same conformance suite as the Node adapters. What a request becomes
// and what a caller is told are the runtime's own rules; this package only
// moves bytes between net/http's types and those rules.
//
// A request whose body is not rewritten is changed in place and its body is
// never read. A response is held only when its body has to be read, which is
// when the site has work for its status and the body is JSON; everything else
// streams through with its headers corrected before the first byte.
package nethttp

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/InvariantApp/Invariant/engines/go/invariant"
)

// Options configure the middleware.
type Options struct {
	Runtime *invariant.Runtime
	// Errors writes refusals in the provider's own error shape.
	Errors invariant.ErrorShaper
	// ConsumerID says who is calling, for counting.
	ConsumerID func(*http.Request) string
	// PinnedContract is the contract pinned to the caller's account, known
	// only once they are authenticated, so only when mounted after that.
	PinnedContract func(*http.Request) string
	// Skip passes a path through untouched.
	Skip func(path string) bool
}

// Handler is next with the runtime in front of it.
func Handler(next http.Handler, options Options) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if options.Skip != nil && options.Skip(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		prepared, ok := prepare(w, r, options)
		if !ok {
			return
		}
		out := &interceptor{
			ResponseWriter: w,
			runtime:        options.Runtime,
			errors:         options.Errors,
			site:           prepared.site,
			contract:       prepared.contract,
			operation:      prepared.operation,
			consumer:       prepared.consumer,
			method:         r.Method,
		}
		next.ServeHTTP(out, r)
		out.finish()
	})
}

type prepared struct {
	site                          *invariant.Site
	contract, operation, consumer string
}

// answer writes a refusal in the provider's shape, with the id the caller
// can quote.
func answer(w http.ResponseWriter, shaped invariant.ShapedError) {
	w.Header().Set("Content-Type", "application/json")
	if shaped.ErrorID != "" {
		w.Header().Set(invariant.ErrorIDHeader, shaped.ErrorID)
	}
	body, _ := json.Marshal(shaped.Body)
	w.WriteHeader(shaped.Status)
	_, _ = w.Write(body)
}

// failed is something that is not a caller's fault, and nothing about it is
// sent to them.
func failed(w http.ResponseWriter, err error) {
	log.Printf("invariant: %v", err)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = w.Write([]byte(`{"error":{"type":"api_error","message":"Internal error.","code":"invariant_internal"}}`))
}

// prepare runs stage one and stage two and adapts the request where it lies.
// False when the request was answered here.
func prepare(w http.ResponseWriter, r *http.Request, options Options) (prepared, bool) {
	runtime := options.Runtime
	headers := r.Header.Clone()
	invariant.SanitizeHeaders(headers)
	refuse := func(err error) (prepared, bool) {
		if shaped, ok := invariant.ContractFailure(options.Errors, err); ok {
			answer(w, shaped)
		} else {
			failed(w, err)
		}
		return prepared{}, false
	}
	decision, err := runtime.Route(r.Method, r.URL.Path, headers)
	if err != nil {
		return refuse(err)
	}
	if decision.Hint != nil {
		headers.Set(invariant.ContractHintHeader, decision.Hint.Label)
	}
	pinned := ""
	if options.PinnedContract != nil {
		pinned = options.PinnedContract(r)
	}
	resolution, err := runtime.Resolve(headers, decision.Path, pinned)
	if err != nil {
		return refuse(err)
	}
	headers.Del(invariant.ContractHintHeader)
	contract := resolution.Label
	operation := strings.ToLower(decision.Method) + " " + decision.Path
	consumer := ""
	if options.ConsumerID != nil {
		consumer = options.ConsumerID(r)
	}
	site, err := runtime.SiteFor(contract, decision.Method, decision.Path, operation, consumer)
	if err != nil {
		return refuse(err)
	}
	headers = runtime.ConditionalHeaders(headers, contract, site)
	path, search := decision.Path, r.URL.RawQuery
	var body []byte
	replaced := false

	if site != nil && (runtime.ReadsRequestBody(site) || site.Envelope != nil) {
		result, err := adaptRequest(runtime, site, r, decision, headers, contract, operation, consumer)
		if err != nil {
			if shaped, ok := invariant.RequestFailure(options.Errors, err); ok {
				answer(w, shaped)
			} else {
				failed(w, err)
			}
			return prepared{}, false
		}
		path, search, headers = result.path, result.search, result.headers
		body, replaced = result.body, result.replaced
	}

	r.Method = decision.Method
	r.URL.Path = path
	r.URL.RawPath = ""
	r.URL.RawQuery = search
	r.RequestURI = r.URL.RequestURI()
	r.Header = headers
	if replaced {
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		r.TransferEncoding = nil
	}
	return prepared{site: site, contract: contract, operation: operation, consumer: consumer}, true
}

type adaptedRequest struct {
	path, search string
	headers      http.Header
	body         []byte
	replaced     bool
}

// adaptRequest is the request as the provider's handler should see it. Only
// a JSON body, or a form or XML one the site describes, is ever read, and
// only when the site's program reaches into it.
func adaptRequest(runtime *invariant.Runtime, site *invariant.Site, r *http.Request, decision invariant.RouteDecision, headers http.Header, contract, operation, consumer string) (adaptedRequest, error) {
	out := adaptedRequest{path: decision.Path, search: r.URL.RawQuery, headers: headers}
	contentType := headers.Get("Content-Type")
	isJSON := invariant.IsJSONMediaType(contentType)
	form := !isJSON && invariant.IsFormMediaType(contentType) && site.Form != nil
	// XML likewise, where the operation declares its request body as XML.
	xml := !isJSON && !form && invariant.IsXMLMediaType(contentType) && site.XML != nil && site.XML.Request != nil
	hasBody := runtime.ReadsRequestBody(site) && r.Method != http.MethodGet && r.Method != http.MethodHead &&
		r.Body != nil && r.Body != http.NoBody && r.ContentLength != 0

	if site.Envelope == nil {
		if len(site.Request) == 0 || !hasBody || !(isJSON || form || xml) {
			return out, nil
		}
		text, decoded, err := readBody(r.Body, headers, runtime.MaxBodyBytes())
		if err != nil {
			return out, err
		}
		var adapted []byte
		if xml {
			adapted, err = runtime.AdaptRequestXML(site, text, contentType, contract, operation, consumer)
		} else {
			adapted, err = runtime.AdaptRequestBody(site, text, form, contract, operation, consumer)
		}
		if err != nil {
			return out, err
		}
		out.body, out.replaced = adapted, true
		out.headers = headersForText(headers, len(adapted), decoded)
		return out, nil
	}

	if site.Envelope.Body && hasBody && !isJSON && !form && !xml {
		return out, &invariant.TransformError{
			ChangeID: bodyWriter(site),
			Message:  "This operation's program writes into the request body, and the body sent is not JSON.",
			Kind:     "transform",
		}
	}
	var original *string
	decoded := false
	if site.Envelope.Body && hasBody {
		text, wasDecoded, err := readBody(r.Body, headers, runtime.MaxBodyBytes())
		if err != nil {
			return out, err
		}
		written := string(text)
		original, decoded = &written, wasDecoded
	}
	result, err := runtime.AdaptEnvelope(site, invariant.EnvelopeRequest{
		Path:    decision.Path,
		Search:  r.URL.RawQuery,
		Headers: headerList(headers),
		Body:    original,
		Form:    form,
		XML:     xml,
	}, contract, operation, consumer)
	if err != nil {
		return out, err
	}
	out.path, out.search = result.Path, result.Search
	out.headers = http.Header{}
	for _, line := range result.Headers {
		out.headers.Add(line[0], line[1])
	}
	if result.Body != nil && (original != nil || *result.Body != "") {
		if original == nil {
			// A body the program built from parameters, where the caller sent none.
			out.headers.Set("Content-Type", "application/json")
		}
		out.body, out.replaced = []byte(*result.Body), true
		out.headers = headersForText(out.headers, len(out.body), decoded)
	}
	return out, nil
}

// bodyWriter is the first Change whose instructions reach the body.
func bodyWriter(site *invariant.Site) string {
	for _, instr := range site.Envelope.Instrs {
		for _, path := range invariant.TouchedPaths(instr) {
			if len(path) > 0 && path[0] == "@body" {
				return instr.C
			}
		}
	}
	return ""
}

// headerList is every header line, names in a stable order and each name's
// values in the order received.
func headerList(headers http.Header) [][2]string {
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	var lines [][2]string
	for _, name := range names {
		for _, value := range headers[name] {
			lines = append(lines, [2]string{strings.ToLower(name), value})
		}
	}
	return lines
}

// headersForText are headers for a body rebuilt from text: its new length,
// no stale encoding, and no digest of bytes that are no longer sent.
func headersForText(source http.Header, length int, decoded bool) http.Header {
	headers := source.Clone()
	if decoded {
		headers.Del("Content-Encoding")
	}
	for _, name := range []string{"Content-Md5", "Digest", "Repr-Digest", "Content-Digest", "Transfer-Encoding"} {
		headers.Del(name)
	}
	headers.Set("Content-Length", strconv.Itoa(length))
	return headers
}

// readBody reads a body, decoded, refusing past the limit without holding
// the rest. The count is of decoded bytes, because a small compressed body
// can expand to anything.
func readBody(body io.Reader, headers http.Header, limit int) ([]byte, bool, error) {
	var encodings []string
	for _, token := range strings.Split(strings.Join(headers.Values("Content-Encoding"), ","), ",") {
		if token = strings.ToLower(strings.TrimSpace(token)); token != "" && token != "identity" {
			encodings = append(encodings, token)
		}
	}
	if len(encodings) == 0 {
		if declared, err := strconv.Atoi(headers.Get("Content-Length")); err == nil && declared > limit {
			return nil, false, &invariant.BodyTooLargeError{Limit: limit}
		}
	}
	reader := body
	// Listed in the order they were applied, so undone in reverse.
	for index := len(encodings) - 1; index >= 0; index-- {
		var err error
		switch encodings[index] {
		case "gzip", "x-gzip":
			reader, err = gzip.NewReader(reader)
		case "deflate":
			reader, err = zlib.NewReader(reader)
		default:
			return nil, false, &invariant.UnsupportedEncodingError{Encoding: encodings[index]}
		}
		if err != nil {
			return nil, false, &invariant.UnsupportedEncodingError{Encoding: strings.Join(encodings, ", ")}
		}
	}
	text, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if err != nil {
		if len(encodings) > 0 {
			return nil, false, &invariant.UnsupportedEncodingError{Encoding: strings.Join(encodings, ", ")}
		}
		return nil, false, err
	}
	if len(text) > limit {
		return nil, false, &invariant.BodyTooLargeError{Limit: limit}
	}
	return text, len(encodings) > 0, nil
}

// interceptor corrects the response on its way out. Nothing reaches the
// connection until the status and content type are known; then a body the
// program describes is held and adapted as a whole, and anything else goes
// out as the handler wrote it, streamed, with its headers corrected first.
type interceptor struct {
	http.ResponseWriter
	runtime                       *invariant.Runtime
	errors                        invariant.ErrorShaper
	site                          *invariant.Site
	contract, operation, consumer string
	method                        string
	status                        int
	mode                          string
	held                          bytes.Buffer
}

func (w *interceptor) choose(status int) {
	if w.mode != "" {
		return
	}
	w.status = status
	headers := w.ResponseWriter.Header()
	bodyless := strings.EqualFold(w.method, http.MethodHead) || status == http.StatusNotModified
	stands := status
	if status == http.StatusNotModified {
		stands = http.StatusOK
	}
	adaptsBody := w.site != nil && w.runtime.RespondsTo(w.site, status) && w.readsBody(headers.Get("Content-Type"), status)
	adaptsHead := w.site != nil && bodyless && w.runtime.RespondsTo(w.site, stands)
	// A status the caller's contract promised differently is answered as it
	// promised, whatever the body.
	_, answersAs := w.runtime.StatusFor(w.site, status)
	if adaptsBody || adaptsHead || answersAs {
		w.mode = "hold"
		return
	}
	w.mode = "pass"
	// Corrected before the first byte: a cache must know this answer depends
	// on the contract, whatever the body.
	if w.contract != w.runtime.CurrentLabel() {
		headers.Set(invariant.ContractResponseHeader, w.contract)
	}
	invariant.AppendVary(headers, w.runtime.VaryOn())
	w.ResponseWriter.WriteHeader(status)
}

func (w *interceptor) WriteHeader(status int) {
	// Informational answers pass straight through and decide nothing.
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.choose(status)
}

func (w *interceptor) Write(chunk []byte) (int, error) {
	if w.mode == "" {
		w.choose(http.StatusOK)
	}
	if w.mode == "pass" {
		return w.ResponseWriter.Write(chunk)
	}
	return w.held.Write(chunk)
}

// Flush sends what a streaming handler has written, when it is not held.
func (w *interceptor) Flush() {
	if w.mode == "" {
		w.choose(http.StatusOK)
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok && w.mode == "pass" {
		flusher.Flush()
	}
}

// Unwrap lets http.ResponseController reach the connection's own writer.
func (w *interceptor) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// finish adapts a held answer once the handler is done: the one place an
// answer is rewritten, so every path through it agrees.
func (w *interceptor) finish() {
	if w.mode == "" {
		w.choose(http.StatusOK)
	}
	if w.mode != "hold" {
		return
	}
	headers := w.ResponseWriter.Header()
	adapted := w.contract != w.runtime.CurrentLabel()
	if adapted {
		headers.Set(invariant.ContractResponseHeader, w.contract)
	}
	invariant.AppendVary(headers, w.runtime.VaryOn())
	mark := func() {
		if etag := headers.Get("Etag"); etag != "" {
			if marked := invariant.MarkEtag(etag, w.contract); marked == "" {
				headers.Del("Etag")
			} else {
				headers.Set("Etag", marked)
			}
		}
	}

	// The status the caller's contract promised for this answer, where a
	// Change moved it; the work for the body is still the provider's status's.
	answered, answers := invariant.Answer{}, false
	if adapted {
		answered, answers = w.runtime.StatusFor(w.site, w.status)
	}
	shown := w.status
	if answers {
		shown = answered.Status
	}

	// A 304 stands for the 200 it revalidates; a HEAD for the GET it mirrors.
	head := strings.EqualFold(w.method, http.MethodHead)
	stands := w.status
	if w.status == http.StatusNotModified {
		stands = http.StatusOK
	}
	if adapted && (head || w.status == http.StatusNotModified) && (w.runtime.RespondsTo(w.site, stands) || answers) {
		if answers && answered.Empty {
			withoutBody(headers)
		} else {
			mark()
		}
		if head {
			// It describes bytes the caller is never sent.
			headers.Del("Content-Length")
			w.ResponseWriter.WriteHeader(shown)
			return
		}
		w.ResponseWriter.WriteHeader(w.status)
		return
	}
	if answers && answered.Empty {
		// The caller's contract promised no body with this status, so whatever
		// the provider sent with its own is not sent on. Its entity tag names
		// the resource rather than these bytes, and is left as it came.
		withoutBody(headers)
		if shown != http.StatusNoContent && shown != http.StatusResetContent {
			headers.Set("Content-Length", "0")
		}
		w.ResponseWriter.WriteHeader(shown)
		return
	}
	body := w.held.Bytes()
	contentType := headers.Get("Content-Type")
	if w.status == http.StatusNoContent || w.status == http.StatusNotModified || len(body) == 0 ||
		!w.runtime.RespondsTo(w.site, w.status) || !w.readsBody(contentType, w.status) {
		w.ResponseWriter.WriteHeader(shown)
		_, _ = w.ResponseWriter.Write(body)
		return
	}

	text, decoded, err := readBody(bytes.NewReader(body), headers, w.runtime.MaxBodyBytes())
	var transformed invariant.Transformed
	if err == nil {
		if invariant.IsJSONMediaType(contentType) {
			transformed, err = w.runtime.TransformResponseBody(w.site, w.status, text, w.contract, w.operation, w.consumer)
		} else {
			transformed, err = w.runtime.TransformResponseXML(w.site, w.status, text, contentType, w.contract, w.operation, w.consumer)
		}
	}
	if err != nil {
		shaped, ok := invariant.ResponseFailure(w.errors, err)
		for name := range headers {
			delete(headers, name)
		}
		if !ok {
			failed(w.ResponseWriter, err)
			return
		}
		headers.Set(invariant.ContractResponseHeader, w.contract)
		invariant.AppendVary(headers, w.runtime.VaryOn())
		answer(w.ResponseWriter, shaped)
		return
	}
	rebuilt := headersForText(headers, len(transformed.Body), decoded)
	for name := range headers {
		delete(headers, name)
	}
	for name, values := range rebuilt {
		headers[name] = values
	}
	if !bytes.Equal(transformed.Body, text) {
		mark()
	}
	if len(transformed.Folded) > 0 {
		// Only when a fold fired: the caller was shown a value their contract
		// names in place of one it does not, and this is how they can know.
		headers.Set(invariant.FoldedHeader, strings.Join(transformed.Folded, ", "))
	}
	w.ResponseWriter.WriteHeader(shown)
	_, _ = w.ResponseWriter.Write(transformed.Body)
}

// readsBody says whether an answer of this type is one the site describes:
// JSON, or XML where the site describes the body it answered status with.
func (w *interceptor) readsBody(contentType string, status int) bool {
	if invariant.IsJSONMediaType(contentType) {
		return true
	}
	return invariant.IsXMLMediaType(contentType) && w.runtime.XMLResponseFor(w.site, status)
}

// withoutBody takes off every header that describes a body not sent on.
func withoutBody(headers http.Header) {
	for _, name := range []string{
		"Content-Type", "Content-Length", "Content-Encoding", "Content-Language",
		"Content-Location", "Content-Range", "Content-Md5", "Digest", "Repr-Digest", "Content-Digest",
	} {
		headers.Del(name)
	}
}
