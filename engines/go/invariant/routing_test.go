package invariant

import (
	"errors"
	"net/http"
	"testing"
)

const routedProgram = `{
  "irVersion": 2, "api": "a", "current": "sha256:0", "currentLabel": "v3",
  "basePath": "/v3",
  "identity": [
    {"kind": "header", "name": "API-Version"},
    {"kind": "urlPrefix", "map": {"/legacy": "v1"}},
    {"kind": "principal"},
    {"kind": "default", "label": "v3"}
  ],
  "contracts": {
    "v1": {
      "label": "v1", "basePath": "/v1",
      "routes": [{"from": {"method": "get", "path": "/users/{id}"}, "to": {"method": "get", "path": "/accounts/{id}"}, "c": "chg_rename"}],
      "sites": {"get /accounts/{id}": {"response": {"2XX": [{"k": "move", "from": "/name", "to": "/full_name", "c": "chg_name"}]}}},
      "behaviors": ["chg_deferred"],
      "retired": [
        {"method": "delete", "path": "/accounts/{id}", "c": "chg_gone", "refuse": true, "guidance": "Close the account instead."},
        {"method": "post", "path": "/exports", "c": "chg_exports"}
      ]
    }
  }
}`

func loadRouted(t *testing.T, options Options) *Runtime {
	t.Helper()
	runtime, err := Load([]byte(routedProgram), options)
	if err != nil {
		t.Fatal(err)
	}
	return runtime
}

func TestRoutingFollowsTheReference(t *testing.T) {
	runtime := loadRouted(t, Options{})
	header := func(pairs ...string) http.Header {
		h := http.Header{}
		for i := 0; i < len(pairs); i += 2 {
			h.Set(pairs[i], pairs[i+1])
		}
		return h
	}

	// An old path under an older base path is moved, and says whose it was.
	decision, err := runtime.Route("GET", "/v1/users/7", header())
	if err != nil {
		t.Fatal(err)
	}
	if decision.Path != "/v3/accounts/7" || !decision.Rewritten || decision.Hint == nil || decision.Hint.Label != "v1" {
		t.Fatalf("route: %+v %+v", decision, decision.Hint)
	}

	// A contract that does not exist is refused, never served as current.
	_, err = runtime.Route("GET", "/v3/accounts/7", header("api-version", "v9"))
	var unknown *UnsupportedContractError
	if !errors.As(err, &unknown) || unknown.Message != `No contract is called "v9". This API serves v1 and v3.` {
		t.Fatalf("unknown contract: %v", err)
	}
	if ErrorIDOf(err) == "" || ErrorIDOf(err) != ErrorIDOf(err) {
		t.Fatal("an error keeps the id it was given")
	}

	for _, test := range []struct {
		headers http.Header
		path    string
		pinned  string
		want    ContractResolution
	}{
		{header("API-Version", "v1"), "/v3/x", "", ContractResolution{"v1", "header"}},
		{header(), "/legacy/x", "", ContractResolution{"v1", "urlPrefix"}},
		{header(), "/v3/x", "v1", ContractResolution{"v1", "principal"}},
		{header(), "/v3/x", "", ContractResolution{"v3", "default"}},
	} {
		got, err := runtime.Resolve(test.headers, test.path, test.pinned)
		if err != nil || got != test.want {
			t.Fatalf("resolve %v %s: %+v %v", test.headers, test.path, got, err)
		}
	}

	// A status class in the program matches a concrete status.
	site, err := runtime.SiteFor("v1", "HEAD", "/v3/accounts/7", "", "")
	if err != nil || site == nil || !runtime.RespondsTo(site, 200) || runtime.RespondsTo(site, 404) {
		t.Fatalf("site: %v %v", site, err)
	}

	// Retired and refused is gone before anything else; retired and passed on
	// is the provider's to answer.
	_, err = runtime.SiteFor("v1", "DELETE", "/v3/accounts/7", "", "")
	var retired *RetiredEndpointError
	if !errors.As(err, &retired) || retired.Message != "DELETE /v3/accounts/7 was retired after contract v1. Close the account instead." {
		t.Fatalf("retired: %v", err)
	}
	if gone := runtime.RetiredFor("v1", "post", "/v3/exports"); gone == nil || gone.ChangeID != "chg_exports" {
		t.Fatalf("retired for: %v", gone)
	}
	shaped, ok := ContractFailure(ErrorShaper{}, err)
	if !ok || shaped.Status != 410 || shaped.ErrorID == "" {
		t.Fatalf("shaped: %+v", shaped)
	}
}

func TestSwitchedOffIsRefused(t *testing.T) {
	flags := Flags{}
	var events []OutcomeEvent
	runtime := loadRouted(t, Options{
		Flags:     func() Flags { return flags },
		OnOutcome: func(event OutcomeEvent) { events = append(events, event) },
	})
	flags.DisabledChanges = []string{"chg_name"}
	_, err := runtime.SiteFor("v1", "GET", "/v3/accounts/7", "get /v3/accounts/7", "")
	var off *UnsupportedContractError
	if !errors.As(err, &off) || off.Message != "Contract v1 cannot be served right now: change chg_name is switched off" {
		t.Fatalf("switched off: %v", err)
	}
	if len(events) != 1 || events[0].Outcome != "refused" || events[0].ErrorID != ErrorIDOf(err) {
		t.Fatalf("events: %+v", events)
	}
}

func TestIdentityMustNameKnownContracts(t *testing.T) {
	_, err := Load([]byte(routedProgram), Options{Identity: []Identity{{Kind: "default", Label: "v2"}}})
	if err == nil {
		t.Fatal("a default naming no contract loads")
	}
}

func TestProgramsTooNewAreRefused(t *testing.T) {
	for _, program := range []string{
		`{"irVersion": 3}`,
		`{"irVersion": 2, "minRuntime": "99.0.0", "compiledBy": "@invariant/compiler@99.0.0"}`,
	} {
		_, err := Load([]byte(program), Options{})
		var tooNew *ProgramTooNewError
		if !errors.As(err, &tooNew) {
			t.Fatalf("%s: %v", program, err)
		}
	}
	if compareVersions("1.2.0-rc.1", "1.2.0") != -1 || compareVersions("1.10.0", "1.9.9") != 1 {
		t.Fatal("versions compare as the reference compares them")
	}
}

func TestEntityTagsAndVary(t *testing.T) {
	if got := MarkEtag(`W/"v7"`, "v1"); got != `W/"v7~v1"` {
		t.Fatal(got)
	}
	if got := MarkEtag(`v7`, "v1"); got != "" {
		t.Fatal(got)
	}
	headers := http.Header{}
	headers.Set("If-None-Match", `"a~v1", "b~v2", *`)
	headers.Set("If-Match", `"a~v2"`)
	out := UnmarkConditionals(headers, "v1")
	if out.Get("If-None-Match") != `"a", *` || out.Get("If-Match") != `"~"` {
		t.Fatalf("%v", out)
	}
	if headers.Get("If-Match") != `"a~v2"` {
		t.Fatal("the caller's headers are not changed in place")
	}
	vary := http.Header{}
	vary.Set("Vary", "Accept")
	AppendVary(vary, []string{"api-version", "accept"})
	if vary.Get("Vary") != "Accept, api-version" {
		t.Fatal(vary.Get("Vary"))
	}
}

func TestOutboundPayloadsAreAdaptedForTheSubscriber(t *testing.T) {
	program := `{
	  "irVersion": 2, "api": "a", "current": "sha256:0", "currentLabel": "new",
	  "identity": [{"kind": "default", "label": "new"}],
	  "contracts": {"old": {
	    "label": "old", "routes": [], "sites": {}, "behaviors": [], "retired": [],
	    "outbound": {"POST webhook:payment.succeeded": [{"k": "move", "from": "/amount_cents", "to": "/amount", "c": "chg_cents"}]}
	  }}
	}`
	flags := Flags{}
	runtime, err := Load([]byte(program), Options{Flags: func() Flags { return flags }})
	if err != nil {
		t.Fatal(err)
	}
	out, err := runtime.AdaptOutbound("old", "webhook:payment.succeeded", []byte(`{"id":"p_1","amount_cents":1999}`), "", "")
	if err != nil || string(out.Body) != `{"id":"p_1","amount":1999}` {
		t.Fatalf("%s %v", out.Body, err)
	}
	same, _ := runtime.AdaptOutbound("new", "webhook:payment.succeeded", []byte(`{"amount_cents":1}`), "", "")
	if string(same.Body) != `{"amount_cents":1}` {
		t.Fatal("a current subscriber's payload is changed")
	}
	flags.DisabledChanges = []string{"chg_cents"}
	if _, err := runtime.AdaptOutbound("old", "webhook:payment.succeeded", []byte(`{}`), "", ""); err == nil {
		t.Fatal("a switched-off Change is sent anyway")
	}
}
