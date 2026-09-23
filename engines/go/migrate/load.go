package main

import (
	"fmt"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

// loadMode is what every command needs: syntax and types for the packages
// asked about, and only export data for what they import. Type-checking a
// consumer's whole dependency graph from source would take gigabytes; export
// data is what the compiler already wrote down about each dependency.
const loadMode = packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles |
	packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo |
	packages.NeedImports | packages.NeedModule

func load(request Request) (*token.FileSet, []*packages.Package, error) {
	fset := token.NewFileSet()
	overlay := make(map[string][]byte, len(request.Overlay))
	for path, text := range request.Overlay {
		overlay[path] = []byte(text)
	}
	config := &packages.Config{
		Mode:       loadMode,
		Dir:        request.Dir,
		Tests:      request.Tests,
		Env:        os.Environ(),
		BuildFlags: request.BuildFlags,
		Fset:       fset,
		Overlay:    overlay,
	}
	loaded, err := packages.Load(config, request.Packages...)
	if err != nil {
		return nil, nil, fmt.Errorf("loading %s: %w", strings.Join(request.Packages, " "), err)
	}
	return fset, loaded, nil
}

// fileOrder is every syntax tree once, in a stable order. With tests loaded,
// a package's files appear in both its plain and its test variant; the test
// variant is checked with more files beside them, so it is preferred.
type loadedFile struct {
	path string
	pkg  *packages.Package
	file int
}

func filesOf(loaded []*packages.Package, within string) []loadedFile {
	chosen := map[string]loadedFile{}
	for _, pkg := range loaded {
		for index, path := range pkg.CompiledGoFiles {
			if index >= len(pkg.Syntax) || !isWithin(path, within) {
				continue
			}
			current, seen := chosen[path]
			if !seen || len(pkg.CompiledGoFiles) > len(current.pkg.CompiledGoFiles) {
				chosen[path] = loadedFile{path: path, pkg: pkg, file: index}
			}
		}
	}
	paths := make([]string, 0, len(chosen))
	for path := range chosen {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	files := make([]loadedFile, 0, len(paths))
	for _, path := range paths {
		files = append(files, chosen[path])
	}
	return files
}

func isWithin(path, dir string) bool {
	if dir == "" {
		return true
	}
	relative, err := filepath.Rel(dir, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// isTarget says whether an import path is one of the SDK's: its module path
// covers every package inside it, and nothing else that merely shares a
// prefix (`github.com/google/go-github/v88` is not `.../v880`).
func isTarget(path string, targets []string) bool {
	for _, target := range targets {
		if path == target || strings.HasPrefix(path, target+"/") {
			return true
		}
	}
	return false
}

// relativeTo prints types as the package they are declared in reads them:
// its own names bare, every other package by its full path. Two releases of
// an SDK then print their own types the same way even though their import
// paths differ by a major version.
func relativeTo(pkg *types.Package) types.Qualifier {
	return func(other *types.Package) string {
		if other == pkg {
			return ""
		}
		return other.Path()
	}
}

// loadErrors are the problems loading met other than type errors, which are
// reported as diagnostics, and other than the compiler's own account of those
// same errors, which the go command prints when it builds export data for a
// package that does not compile.
func loadErrors(loaded []*packages.Package) []string {
	var errors []string
	for _, pkg := range loaded {
		for _, problem := range pkg.Errors {
			if problem.Kind == packages.TypeError || strings.HasPrefix(problem.Msg, "# ") {
				continue
			}
			errors = append(errors, problem.Error())
		}
	}
	return errors
}
