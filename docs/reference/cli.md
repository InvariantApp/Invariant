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
`invariant/compiled/program.json`; `--out <path>` moves it. Beside it goes
`invariant.lock`, which names the program by its digest, the same digest the
evolution bundle records. Commit both. Given that digest, the runtime refuses
any other program at load, so one changed between your build and your server
is never served:

```ts
const lock = JSON.parse(await readFile("invariant/compiled/invariant.lock", "utf8"));
const runtime = createRuntime({ program, programDigest: lock.programDigest });
```

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

## `invariant migrate`

Moves one consumer repository to a release, with the same engine the hosted
service runs, and says what it would change and what it leaves to a person.
It is a consumer's command: it needs no `invariant.yaml`.

```
invariant migrate job.json --key publisher.pub --sandbox oci-rootless --out result.json
```

The job names everything, with paths relative to the job file:

```json
{
  "language": "typescript",
  "repo": "../billing-service",
  "bundle": "acme-2026-09-20.bundle.json",
  "sdk": "acme-sdk.json",
  "from": "2.4.0"
}
```

| Field | |
|---|---|
| `language` | `typescript`, `python` or `go`. |
| `repo` | The consumer's repository. It is read, never written unless `--write` is given. |
| `bundle` | A signed release. Its Changes are used only once `--key` checks its signature. |
| `changes` | Instead of a bundle: a list of Changes, or the path to one. |
| `sdk` | The [SDK map](../migrations.md#what-it-needs-from-you), or the path to one. A Go map names `module.path` and `upgradeTo.path` and `version`. |
| `from` | The release of the SDK the consumer uses today. |
| `tsconfig` | TypeScript: the project file, relative to the repository (default `tsconfig.json`). |
| `sources` | TypeScript and Python: the files to read, relative to the repository. Python reads every file that imports the SDK by default. |
| `module`, `packages` | Go: the module's directory (default the root) and the packages to read (default `./...`). |

A migration is always two steps. The **fetch** downloads both releases of the
SDK (from npm, from PyPI as wheels, or through the Go module proxy, with the
modules the consumer and the SDK require), with install scripts off, and reads
nothing of the repository but a go.mod. The **analysis** then reads the
repository against those releases with no network at all.

By default both steps run in this process. `--sandbox oci-rootless` runs each
in a container of its own, through docker or podman: the fetch on a network
whose only way out is an egress proxy that opens tunnels to the public
registries and nothing else, the analysis with no network, and both as a
non-root user with a read-only root filesystem, no capabilities, and limits
on memory, CPU and time. The containers run this same installation of the
CLI, mounted read-only, so what runs inside is what would have run outside.
What comes back is checked before anything is written: every path must be a
file inside the repository. The `k8s-job` and `fly-machine` sandboxes are for
the hosted service, which keeps its workspaces on a cluster or on Fly
volumes; see `@invariant-app/sandbox`.

| Option | |
|---|---|
| `--sandbox <d>` | `oci-rootless` to run each step in a container (default: in this process). |
| `--image <ref>` | The image the containers run: any with Node 22.18 or later, and Go for a Go job (default: Node 24, pinned by digest). |
| `--runtime <r>` | `docker` or `podman` (default: whichever is running). |
| `--allow-host <h>` | A host the fetch may reach beyond `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `proxy.golang.org` and `sum.golang.org`, such as a private registry. Repeatable. |
| `--key <path>` | The publisher's Ed25519 public key, in PEM form, for the job's bundle. |
| `--write` | Apply the edits to the repository. |
| `--out <path>` | Write the result as JSON: each changed file's new contents, each place left to a person, and the type errors before and after. |

`migrate --phase fetch|analyse <request>` is what runs inside a sandbox; it is
not meant to be run by hand.

## Environment

| Variable | Used by | |
|---|---|---|
| `INVARIANT_SIGNING_KEY` | `release` | The Ed25519 private key, in PEM form. |
| `INVARIANT_TOKEN` | `publish`, `status` | A token issued in the dashboard. |
| `INVARIANT_URL` | `publish`, `status` | The service, when not the hosted one. |
