---
"@invariant-app/cli": minor
"@invariant-app/runtime": minor
"@invariant-app/migrate-ts": minor
"@invariant-app/oasdiff-darwin": patch
"@invariant-app/oasdiff-linux-arm64": patch
"@invariant-app/oasdiff-linux-x64": patch
"@invariant-app/oasdiff-win32-arm64": patch
"@invariant-app/oasdiff-win32-x64": patch
---

`invariant compile` writes `invariant.lock` beside the program, naming it by the digest the evolution bundle records. Given that digest as `programDigest`, `createRuntime` refuses at load any other program, so one changed between the build and the server is never served; `programDigest` is exported for checking a program by hand.

`invariant check` refuses a release whose behavior flag is used in authentication or authorization code, found by the file's path or the words around the flag. A caller chooses its own contract, so a branch on it there would let a caller choose its own permissions.

`migrate` takes an optional `repair`, a model asked for each function a site was left to a person in. It is sent the Change, why the site was left, and that function only; what it returns is kept only as that one function, type-checking as well as before, and is reported in `repairs` as the model's. Without `repair` no model is asked.

The oasdiff platform packages carry a CycloneDX bill of materials naming the upstream binary by version, source and hash, as every other package already does.
