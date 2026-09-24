package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A go.mod the go command wants to update lists nothing when the loader reads
// export data: go/packages takes the failed build for one that listed no
// packages. foks-proj/go-foks's check against stripe-go 82 read no file and
// found nothing wrong that way; now it says why, and `-mod=mod` on a copy of
// go.mod lets the check go on.
func TestALoadThatListsNothingSaysWhy(t *testing.T) {
	root := t.TempDir()
	write := func(path, text string) {
		t.Helper()
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("dep/go.mod", "module example.com/dep\n\ngo 1.22\n")
	write("dep/dep.go", "package dep\n\nconst X = 1\n")
	write("sdk/go.mod", "module example.com/sdk\n\ngo 1.22\n\nrequire example.com/dep v1.0.0\n\nreplace example.com/dep => ../dep\n")
	write("sdk/sdk.go", "package sdk\n\nimport \"example.com/dep\"\n\ntype Invoice struct{ ID string }\n\nconst D = dep.X\n")
	// The consumer's go.mod does not require what the SDK imports.
	write("consumer/go.mod", "module example.com/consumer\n\ngo 1.22\n\nrequire example.com/sdk v1.0.0\n\nreplace example.com/sdk => ../sdk\n\nreplace example.com/dep => ../dep\n")
	write("consumer/c.go", "package consumer\n\nimport \"example.com/sdk\"\n\nfunc F(i sdk.Invoice) string { return i.Charge }\n")
	t.Setenv("GOFLAGS", "-mod=readonly")
	t.Setenv("GOPROXY", "off")
	t.Setenv("GOWORK", "off")
	t.Setenv("CGO_ENABLED", "0")
	dir := filepath.Join(root, "consumer")

	_, _, err := loadConsumer(Request{Dir: dir, Packages: []string{"./..."}})
	if err == nil || !strings.Contains(err.Error(), "found no packages") {
		t.Fatalf("a load that listed nothing should fail and say so, got %v", err)
	}

	response, err := diagnose(Request{Dir: dir, Packages: []string{"./..."}, Within: dir, BuildFlags: []string{"-mod=mod"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Files) != 1 || len(response.Diagnostics) != 1 ||
		!strings.Contains(response.Diagnostics[0].Message, "i.Charge undefined") {
		t.Errorf("the check should read c.go and find the missing field: %+v", response)
	}
}
