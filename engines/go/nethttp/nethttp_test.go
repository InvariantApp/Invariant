package nethttp

import (
	"bytes"
	"compress/gzip"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/InvariantApp/Invariant/engines/go/invariant"
)

// The cases the shared adapter suite does not reach: what a Go provider
// mounts around the middleware, and the request bodies it has to read.
const program = `{
  "irVersion": 2, "api": "payments", "current": "sha256:0", "currentLabel": "new",
  "identity": [{"kind": "header", "name": "Payments-Version"}, {"kind": "default", "label": "new"}],
  "contracts": {
    "old": {
      "label": "old", "routes": [], "behaviors": [], "retired": [],
      "sites": {
        "post /payments": {"request": [{"k": "move", "from": "/amount", "to": "/amount_cents", "c": "chg_cents"}]},
        "post /charges": {
          "form": {"fields": {"metadata": {"style": "deepObject", "explode": true}}, "types": {}},
          "request": [{"k": "move", "from": "/metadata/order", "to": "/metadata/order_id", "c": "chg_order"}]
        },
        "get /items": {"envelope": {
          "instrs": [{"k": "move", "from": "/@query/limit", "to": "/@query/page_size", "c": "chg_page"}],
          "params": {
            "old": [{"in": "query", "name": "limit", "style": "form", "explode": true, "type": "integer"}],
            "new": [{"in": "query", "name": "page_size", "style": "form", "explode": true, "type": "integer"}]
          },
          "body": false
        }}
      }
    }
  }
}`

// seen answers with what the handler received.
var seen = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write([]byte(r.URL.RequestURI() + "\n" + string(body)))
})

func serve(t *testing.T, wrap func(http.Handler) http.Handler) *httptest.Server {
	t.Helper()
	runtime, err := invariant.Load([]byte(program), invariant.Options{MaxBodyBytes: 64})
	if err != nil {
		t.Fatal(err)
	}
	handler := Handler(seen, Options{Runtime: runtime})
	if wrap != nil {
		handler = wrap(handler)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func send(t *testing.T, server *httptest.Server, method, path, contentType string, body io.Reader, headers ...string) (*http.Response, string) {
	t.Helper()
	request, _ := http.NewRequest(method, server.URL+path, body)
	request.Header.Set("Payments-Version", "old")
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	for i := 0; i < len(headers); i += 2 {
		request.Header.Set(headers[i], headers[i+1])
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	text, _ := io.ReadAll(response.Body)
	return response, string(text)
}

func TestASignatureIsCheckedOverTheBytesTheCallerSent(t *testing.T) {
	// Mounted inside the provider's signature check, the middleware never
	// changes what was verified, and the handler still gets the current shape.
	const secret = "whsec_test"
	sign := func(body []byte) string {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		return hex.EncodeToString(mac.Sum(nil))
	}
	verified := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			if !hmac.Equal([]byte(r.Header.Get("X-Signature")), []byte(sign(body))) {
				http.Error(w, "bad signature", http.StatusUnauthorized)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			next.ServeHTTP(w, r)
		})
	}
	server := serve(t, verified)
	body := []byte(`{"amount":1999}`)
	response, text := send(t, server, "POST", "/payments", "application/json", bytes.NewReader(body), "X-Signature", sign(body))
	if response.StatusCode != 200 || text != "/payments\n"+`{"amount_cents":1999}` {
		t.Fatalf("%d %s", response.StatusCode, text)
	}
}

func TestACompressedBodyIsReadDecodedAndSentPlain(t *testing.T) {
	server := serve(t, nil)
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = writer.Write([]byte(`{"amount":5}`))
	_ = writer.Close()
	response, text := send(t, server, "POST", "/payments", "application/json", &compressed, "Content-Encoding", "gzip")
	if response.StatusCode != 200 || text != "/payments\n"+`{"amount_cents":5}` {
		t.Fatalf("%d %s", response.StatusCode, text)
	}
}

func TestAFormBodyIsAdaptedWhereTheOperationDeclaresOne(t *testing.T) {
	server := serve(t, nil)
	response, text := send(t, server, "POST", "/charges", "application/x-www-form-urlencoded",
		strings.NewReader("amount=100&metadata[order]=6735"))
	if response.StatusCode != 200 || text != "/charges\namount=100&metadata[order_id]=6735" {
		t.Fatalf("%d %s", response.StatusCode, text)
	}
}

func TestAQueryParameterIsRenamedAndTheRestKept(t *testing.T) {
	server := serve(t, nil)
	response, text := send(t, server, "GET", "/items?q=a%20b&limit=10", "", nil)
	if response.StatusCode != 200 || text != "/items?q=a%20b&page_size=10\n" {
		t.Fatalf("%d %q", response.StatusCode, text)
	}
}

func TestRefusalsAreThereQuoteableAndShaped(t *testing.T) {
	server := serve(t, nil)
	for _, test := range []struct {
		name, contentType, body, encoding string
		status                            int
		code                              string
	}{
		{"too large", "application/json", `{"amount":1,"pad":"` + strings.Repeat("x", 80) + `"}`, "", 413, invariant.CodeBodyTooLarge},
		{"not JSON", "application/json", `{"amount":`, "", 400, invariant.CodeRequestNotTranslatable},
		{"an encoding nobody here reads", "application/json", `{"amount":1}`, "br", 415, invariant.CodeEncodingUnsupported},
	} {
		headers := []string{}
		if test.encoding != "" {
			headers = append(headers, "Content-Encoding", test.encoding)
		}
		response, text := send(t, server, "POST", "/payments", test.contentType, strings.NewReader(test.body), headers...)
		var shaped struct {
			Error struct{ Code string } `json:"error"`
		}
		_ = json.Unmarshal([]byte(text), &shaped)
		if response.StatusCode != test.status || shaped.Error.Code != test.code ||
			!strings.HasPrefix(response.Header.Get(invariant.ErrorIDHeader), "err_") {
			t.Fatalf("%s: %d %s %v", test.name, response.StatusCode, text, response.Header)
		}
	}
}
