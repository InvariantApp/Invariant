# Contributing

Thank you for helping. A few things keep the project reliable.

## Before you open a pull request

- `pnpm install`, then `pnpm ci:local`, which runs lint, type checks, every
  test suite and the conformance vectors, as CI does.
- A bug fix starts with a test that reproduces the bug the way a user meets it,
  and keeps that test.
- A change to the program format or the runtime updates the conformance vectors
  (`conformance/vectors.json` is generated; the test that checks it rewrites
  it) and passes in the Go engine too: `cd engines/go && go test ./...`.
- Do not edit `CHANGELOG.md` files; Changesets writes them. Add a changeset
  with `pnpm changeset` instead.

## Sign-off

Contributions are accepted under the [Developer Certificate of
Origin](https://developercertificate.org/). Sign off each commit with
`git commit -s`, which adds a `Signed-off-by` line certifying that you wrote the
change or have the right to submit it under the Apache License 2.0.

## Reporting security issues

Privately, as described in [SECURITY.md](SECURITY.md), never in a public issue.
