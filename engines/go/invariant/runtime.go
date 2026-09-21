package invariant

import (
	"errors"
	"strconv"
	"strings"
)

func itoa(n int) string { return strconv.Itoa(n) }

// Site is the compiled work for one operation of one contract.
type Site struct {
	Request  []*Instr
	Response map[string][]*Instr
	// Envelope is the program over the whole request, where a Change reaches
	// a parameter.
	Envelope *Envelope
	// Template is the site's path, split on "/", as the contract writes it.
	Template []string
	// Form is how the request body is written when it arrives form-encoded.
	Form *Form
}

// Contract is one historical contract, compiled straight to current.
type Contract struct {
	Label  string
	Sites  map[string]*Site
	blocks blocks
}

// Program is a decoded program.
type Program struct {
	API          string
	Current      string
	CurrentLabel string
	Contracts    map[string]*Contract
}

// Runtime runs a program.
type Runtime struct {
	program *Program
	limits  Limits
}

// Options configure a runtime.
type Options struct {
	// Limits bound what one body may cost; zero values take the defaults.
	Limits Limits
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
	return &Runtime{program: program, limits: limits}, nil
}

func decodeProgram(raw any) (*Program, error) {
	value, err := asObject(raw, "program")
	if err != nil {
		return nil, err
	}
	version, _ := field(value, "irVersion").(Number)
	if version != Number("2") {
		return nil, programError("Unsupported program format %v; this engine reads format %d", field(value, "irVersion"), ProgramVersion)
	}
	if err := expectKeys(value, []string{
		"irVersion", "compiledBy", "minRuntime", "api", "current", "currentLabel",
		"contracts", "blocks", "basePath", "identity",
	}, "program"); err != nil {
		return nil, err
	}
	shared, err := decodeBlocks(field(value, "blocks"), "program.blocks", blocks{})
	if err != nil {
		return nil, err
	}
	program := &Program{Contracts: map[string]*Contract{}}
	if program.API, err = stringField(value, "api", "program"); err != nil {
		return nil, err
	}
	if program.Current, err = stringField(value, "current", "program"); err != nil {
		return nil, err
	}
	if program.CurrentLabel, err = stringField(value, "currentLabel", "program"); err != nil {
		return nil, err
	}
	contracts, err := asObject(field(value, "contracts"), "program.contracts")
	if err != nil {
		return nil, err
	}
	for _, label := range contracts.Keys() {
		where := "program.contracts." + label
		entry, _ := contracts.Get(label)
		contract, err := asObject(entry, where)
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
		decoded := &Contract{Label: label, Sites: map[string]*Site{}, blocks: named}
		sites, err := asObject(field(contract, "sites"), where+".sites")
		if err != nil {
			return nil, err
		}
		for _, key := range sites.Keys() {
			siteWhere := where + ".sites." + key
			// Only the method is case-insensitive; a path is not.
			separator := strings.IndexByte(key, ' ')
			if separator <= 0 {
				return nil, programError("%s.sites has a key %q that is not \"method path\"", where, key)
			}
			method, path := strings.ToLower(key[:separator]), key[separator+1:]
			rawSite, _ := sites.Get(key)
			site, err := asObject(rawSite, siteWhere)
			if err != nil {
				return nil, err
			}
			if err := expectKeys(site, []string{"form", "request", "envelope", "response"}, siteWhere); err != nil {
				return nil, err
			}
			_, hasRequest := site.Get("request")
			_, hasEnvelope := site.Get("envelope")
			if hasRequest && hasEnvelope {
				return nil, programError("%s has both request and envelope; one list keeps the order", siteWhere)
			}
			out := &Site{Response: map[string][]*Instr{}, Template: strings.Split(path, "/")}
			if form, present := site.Get("form"); present {
				if out.Form, err = decodeForm(form, siteWhere+".form"); err != nil {
					return nil, err
				}
			}
			if hasEnvelope {
				if out.Envelope, err = decodeEnvelope(field(site, "envelope"), siteWhere+".envelope", named); err != nil {
					return nil, err
				}
			}
			if request, present := site.Get("request"); present {
				if out.Request, err = decodeBlock(request, siteWhere+".request", 0, named, false); err != nil {
					return nil, err
				}
			}
			if response, present := site.Get("response"); present {
				statuses, err := asObject(response, siteWhere+".response")
				if err != nil {
					return nil, err
				}
				for _, status := range statuses.Keys() {
					list, _ := statuses.Get(status)
					if out.Response[status], err = decodeBlock(list, siteWhere+".response."+status, 0, named, false); err != nil {
						return nil, err
					}
				}
			}
			decoded.Sites[method+" "+path] = out
		}
		program.Contracts[label] = decoded
	}
	return program, nil
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
	root, err := Parse(body)
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
