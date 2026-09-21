package invariant

import (
	"fmt"
	"strings"
	"testing"
)

// The same list the reference runtime's bench measures: 340 payments, every
// one adapted by five instructions, parsed, transformed and written again.
func BenchmarkAdaptedList(b *testing.B) {
	items := make([]string, 340)
	for index := range items {
		items[index] = fmt.Sprintf(`{"id":"pay_%d","object":"payment","amount":49.99,"currency":"usd","source":"tok_visa","status":"succeeded","description":"A description of roughly the length a real one has","created":%d}`, index, 1_760_000_000+index)
	}
	body := []byte(`{"object":"list","data":[` + strings.Join(items, ",") + `],"has_more":false}`)
	program := `{
	  "irVersion": 2, "api": "a", "current": "sha256:0", "currentLabel": "new",
	  "identity": [{"kind": "default", "label": "old"}],
	  "contracts": {"old": {"label": "old", "routes": [], "behaviors": [], "retired": [], "sites": {"get /v1/payments": {"response": {"200": [
	    {"k": "move", "from": "/data/*/amount", "to": "/data/*/amount_cents", "c": "money"},
	    {"k": "scale", "path": "/data/*/amount_cents", "exp": 2, "c": "money"},
	    {"k": "enum", "path": "/data/*/status", "map": {"succeeded": "paid"}, "c": "status"},
	    {"k": "set", "path": "/data/*/capture_method", "value": "automatic", "ifAbsent": true, "c": "capture"},
	    {"k": "move", "from": "/data/*/source", "to": "/data/*/payment_method/token", "c": "method"}
	  ]}}}}}
	}`
	runtime, err := Load([]byte(program), Options{})
	if err != nil {
		b.Fatal(err)
	}
	site, err := runtime.SiteFor("old", "GET", "/v1/payments", "", "")
	if err != nil || site == nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(body)))
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if _, err := runtime.TransformResponseBody(site, 200, body, "old", "list", ""); err != nil {
			b.Fatal(err)
		}
	}
}
