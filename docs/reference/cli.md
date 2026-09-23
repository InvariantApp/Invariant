# The `invariant` command

Every command reads `invariant.yaml` in the current directory, or the file
`--config <path>` names. Nothing it does needs the network except `propose`
(unless `--offline`), `publish` and `status`.

## `invariant init`

Sets up a repository: finds the OpenAPI document (or detects a generator and
asks for the command that writes it), snapshots it as the first released
contract, and writes `invariant.yaml` with comments and a CI workflow.

| Option | |
|---|---|
| `--spec <path>` | The document, when there is more than one. |
| `--spec-command <c>`, `--spec-out <path>` | A command that writes the document, and where, for a generated specification. |
| `--api <name>` | The API's name. Default: the document's title. |
| `--label <label>` | The baseline contract's name. Default: today. |
| `--header <name>` | The header callers name a contract in, when detection is wrong. |
| `--no-ci` | Do not write a GitHub Actions workflow. |
| `--force` | Replace an existing `invariant.yaml`. |

## `invariant check`

Does this release's declared Changes explain everything the API did? Exits
non-zero when the release gate blocks.

| Option | |
|---|---|
| `--full` | Also start the real builds and compare what they do. |
| `--format <f>` | `markdown` for a pull request comment, `json` for a machine. |
| `--watch` | Check again whenever a file under the configuration changes. |
| `--comment` | Write the report on the GitLab merge request or Bitbucket pull request this pipeline is for. |
| `--outcomes <path>` | What the deployed runtime reported, as evidence. |
| `--usage <path>` | The usage ledger the runtime's counters wrote. |

With `--impact`, the check asks the service how many callers are still on each
old contract and says so in its report, so a change nothing can serve is read
next to the number of people it would reach. It needs `INVARIANT_TOKEN`, and a
service that cannot be reached is said so rather than counted as nobody.

## `invariant propose`

Drafts Change files for whatever this release has not explained. Drafts are
proposals; a person merging them is the decision.

| Option | |
|---|---|
| `--write` | Write the drafts into `invariant/changes`. |
| `--offline` | Deterministic rules only; no model is asked. |
| `--context <text>` | Notes about this release, weighed as evidence. |

## `invariant compile`

Writes the compiled program the runtime loads, by default to
`invariant/compiled/program.json`; `--out <path>` moves it.

## `invariant release`

Mints the contract, moves the pending Changes into the released step, and
signs the evolution bundle with `INVARIANT_SIGNING_KEY`.

| Option | |
|---|---|
| `--dry-run` | Say what would happen and write nothing. |
| `--repo <name>`, `--commit <sha>`, `--pr <number>` | Where the release came from, recorded in the bundle. |

## `invariant verify`

Opens a signed bundle and checks who signed it against `--key <path>`, an
Ed25519 public key in PEM form (more than one may be given). With `--rebuild`,
also rebuilds the bundle from the commit it names and compares.

## `invariant publish`

Sends the signed releases in `invariant/bundles` to the service, or only the
one named: `invariant publish 2026-09-20`. A release the service already has
is not sent again, so a retried job is harmless. Needs `INVARIANT_TOKEN` with
the `publish` scope.

## `invariant status`

What production is using: each contract, newest first, and who is still on
it, from the counters runtimes report. `--days <n>` sets the window (default
30). Needs `INVARIANT_TOKEN` with the `read` scope.

## `invariant retire`

Says which old contracts nobody is using any more, from `--usage <path>`,
quiet for `--days <n>` (default 30). With `--write`, removes them from
`invariant.yaml`.

## `invariant doctor`

Checks the toolchain, the configuration, every contract, and that the
compiled program is what the Changes compile to now.

## `invariant observe`

Stands in front of the API at `--upstream <url>`, forwards every request
untouched, and checks a sample of the answers against the current contract.
It adapts nothing and changes nothing, so it can be pointed at real traffic
before a provider has adopted anything else.

```
invariant observe --upstream http://127.0.0.1:8080 --port 8081 --sample 5 --out observed.json
```

The report counts, per operation and status, which field did not hold and what
was wrong with it: `getThing 200 /items/*/price: expected string, found
integer`. No value from any response is recorded, which is what makes it safe
to run against production traffic. `--sample` is how many answers in a hundred
to check (100 by default), `--max-body` the most bytes of one answer to read
(a megabyte by default), `--port` the port to listen on (one that is free by
default), and `--out` writes the report as JSON as well as printing it. It stops on Ctrl-C, and reports then.

A specification generated from code and never checked against traffic is the
common case, and everything built on top of one inherits its errors: this is
how a provider finds out first.

## `invariant contract export`

Writes one contract's specification, `--label <c>`, to `--out <path>` or
standard output: for a gateway that validates requests per version.

## `invariant scenarios generate`

Writes the scenarios `check --full` would make from each released contract's
document (or `--label <c>`'s) into `invariant/scenarios`, to keep and edit.

## Environment

| Variable | Used by | |
|---|---|---|
| `INVARIANT_SIGNING_KEY` | `release` | The Ed25519 private key, in PEM form. |
| `INVARIANT_TOKEN` | `publish`, `status` | A token issued in the dashboard. |
| `INVARIANT_URL` | `publish`, `status` | The service, when not the hosted one. |
