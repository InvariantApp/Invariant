# Security policy

Invariant sits in the request path of other people's APIs, so a flaw in it can
be a flaw in theirs. Reports are welcome and taken seriously.

## Reporting a vulnerability

Report privately through GitHub:
[Report a vulnerability](https://github.com/InvariantApp/Invariant/security/advisories/new).
Please do not open a public issue for anything that could be exploited.

Include what you found, how to reproduce it, and what an attacker could do with
it. A proof of concept against your own deployment is ideal; never test against
someone else's.

## What to expect

- An acknowledgement within three working days.
- An assessment, and a fix or mitigation plan, within fourteen days for
  anything that affects the proxy, the runtimes or bundle verification.
- Credit in the advisory, unless you would rather not be named.

## Scope

Everything in this repository: the runtimes and adapters, the sidecar proxy,
the compiler and program format, the CLI and GitHub Action, bundle signing and
verification, the migration engine, and the sandbox it runs in
(`packages/sandbox`: the egress proxy and its allowlist, and the isolation each
driver sets up). The threat model is in [`docs/DESIGN.md`](docs/DESIGN.md),
section 11.

## Supported versions

Until 1.0, only the latest release receives fixes.
