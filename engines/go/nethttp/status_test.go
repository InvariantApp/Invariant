package nethttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/InvariantApp/Invariant/engines/go/invariant"
)

// statusAnswer is an answer as the status vectors write one.
type statusAnswer struct {
	Status  int         `json:"status"`
	Headers [][2]string `json:"headers"`
	Body    string      `json:"body"`
}

type statusVector struct {
	Name   string          `json:"name"`
	Site   json.RawMessage `json:"site"`
	Answer statusAnswer    `json:"answer"`
	Expect struct {
		Answer  *statusAnswer `json:"answer"`
		Absent  []string      `json:"absent"`
		Refuses string        `json:"refuses"`
	} `json:"expect"`
}

// TestStatusVectors holds the middleware to the status vectors: a success
// status an old caller's contract promised differently is answered as it
// promised, with the body its contract promised with it.
func TestStatusVectors(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "conformance", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Statuses []statusVector `json:"statuses"`
	}
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Statuses) == 0 {
		t.Fatal("no status vectors")
	}
	for _, v := range file.Statuses {
		t.Run(v.Name, func(t *testing.T) {
			program := `{"irVersion": 2, "api": "conformance", "current": "sha256:0", "currentLabel": "current",
				"contracts": {"old": {"label": "old", "routes": [], "behaviors": [], "retired": [],
				"sites": {"post /v": ` + string(v.Site) + `}}}}`
			runtime, err := invariant.Load([]byte(program), invariant.Options{
				Identity: []invariant.Identity{{Kind: "default", Label: "old"}},
			})
			if v.Expect.Refuses != "" {
				if err == nil {
					t.Fatalf("expected the program to be refused")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			provider := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				for _, header := range v.Answer.Headers {
					w.Header().Set(header[0], header[1])
				}
				w.WriteHeader(v.Answer.Status)
				_, _ = w.Write([]byte(v.Answer.Body))
			})
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/v", strings.NewReader("{}"))
			request.Header.Set("Content-Type", "application/json")
			Handler(provider, Options{Runtime: runtime}).ServeHTTP(recorder, request)
			expected := v.Expect.Answer
			if recorder.Code != expected.Status {
				t.Fatalf("answered %d, want %d", recorder.Code, expected.Status)
			}
			for _, header := range expected.Headers {
				if got := recorder.Header().Get(header[0]); got != header[1] {
					t.Fatalf("%s is %q, want %q", header[0], got, header[1])
				}
			}
			for _, name := range v.Expect.Absent {
				if got := recorder.Header().Get(name); got != "" {
					t.Fatalf("%s is %q, and must not be sent", name, got)
				}
			}
			if got := recorder.Body.String(); got != expected.Body {
				t.Fatalf("body is %q, want %q", got, expected.Body)
			}
		})
	}
}
