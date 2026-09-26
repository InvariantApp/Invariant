# The `invariant` command

Every command reads `invariant.yaml` in the current directory, or the file
`--config <path>` names. Nothing it does needs the network except `propose`
(unless `--offline`), `publish`, `status` and `migrate`.

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

## `invariant well-known`

Prints `/.well-known/invariant.json`, the document you serve from your own domain listing the
APIs you publish and the Ed25519 keys you sign their releases with, so a consumer can trust a
published release without trusting the service that serves it. See
[Publishing your signing keys](../well-known.md) for the format and how to rotate and revoke.

```
invariant well-known --from invariant.json --key new.pub --retire sha256:41ab... --out invariant.json
```

It takes the API's id from `invariant.yaml`, and lists the public half of
`INVARIANT_SIGNING_KEY` when it is set. When `INVARIANT_URL` is set, the document names it as
where your bundles are published.

| Option | |
|---|---|
| `--key <path>` | A public key to list, in PEM form. Repeatable. A key already listed keeps its `added_at`. |
| `--from <path>` | The document published today. Every key in it is kept as it is, with any revocation. |
| `--revoke <keyid>` | Withdraw a key: nothing it ever signed is trusted. Repeatable. |
| `--retire <keyid>` | Stop a key signing from now: what it signed stays trusted. Repeatable. |
| `--out <path>` | Write the document here rather than to standard output. |

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
| `release` | Instead of a bundle: a provider's published release, read with no account and no key. See below. |
| `changes` | Instead of either: a list of Changes, or the path to one. |
| `sdk` | The [SDK map](../migrations.md#what-it-needs-from-you), or the path to one. A Go map names `module.path` and `upgradeTo.path` and `version`. |
| `from` | The release of the SDK the consumer uses today. Optional: by default each package's own manifest and lockfile say. |
| `package` | One workspace package to migrate, by its directory, instead of every package the repository has. |
| `tsconfig` | TypeScript: the project file, relative to the repository (default the package's `tsconfig.json`). |
| `sources` | TypeScript and Python: the files to read, relative to the repository. Python reads every file that imports the SDK by default. |
| `module`, `packages` | Go: the module's directory (default the root) and the packages to read (default `./...`). |

### A provider's published release

A consumer who is not on GitHub, or who wants to run the migration on their own machine, names
the provider's domain and the API, and needs no account and no key:

```json
{
  "language": "typescript",
  "repo": ".",
  "release": { "provider": "api.acme.example", "api": "acme-payments", "since": "2026-01-15" },
  "sdk": "acme-sdk.json"
}
```

| `release` field | |
|---|---|
| `provider` | The provider's domain. Its signing keys are read from `https://<provider>/.well-known/invariant.json`, over HTTPS only. |
| `api` | The API, by the id its releases carry. The provider's document has to list it. |
| `to` | The contract to migrate to, by label or by `sha256:` digest. Default: the newest published. |
| `since` | The contract the consumer speaks today. Every published step from it to `to` is applied, in order. Default: the one step to `to`. |
| `service` | Where the releases are read from. Default: `--service`, else where the provider's document says, else the hosted service. |

The releases come from the service's public read endpoint, which is a cache and is trusted for
nothing. Each is opened only with a key the provider's own document lists for that API, that
was added before the release was published and had not stopped signing by then, and that was
never revoked. A release signed by any other key is refused with the reason, whatever the
service says about it, and so is one the service lists as one thing and serves as another. Every
request is HTTPS (plain HTTP only to a service on this machine), follows redirects only on the
same host, and is held to a size and a time limit. The provider's document and the service's
listing are kept for a few minutes, and a verified release for a week, in the user's cache
directory; what comes back from that cache is checked again.

### Monorepos

A repository with workspaces is migrated one package at a time, into one result for the whole
repository, which is what one pull request carries:

| Language | What makes a package |
|---|---|
| TypeScript | Each package npm, pnpm or yarn workspaces name (`workspaces` in `package.json`, or `pnpm-workspace.yaml`), and the root. |
| Python | Each directory with a `pyproject.toml`, when there is more than one. |
| Go | Each module a `go.work` uses, or else each directory with a `go.mod`, when there is more than one. |

Each package is migrated from the release of the SDK it uses, read from its own manifest and
then its lockfile: `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock` (or what is installed);
an exact pin in `pyproject.toml` or a requirements file, then `uv.lock`, `poetry.lock` or
`pdm.lock`; the `require` in its `go.mod`. A package that does not use the SDK, or whose release
nothing says, is skipped and the report says why; the job's `from` is used only where a package
declares the SDK and nothing says which release. The report lists each package with what
happened to it, and the result's `packages` says the same as JSON. A file two packages would
edit differently is left as it is, and a note says so. A package that fails does not stop the
others, but the command exits non-zero.

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
| `--service <url>` | The service a job's `release` is read from, overriding the job and the provider's document. |
| `--write` | Apply the edits to the repository. |
| `--out <path>` | Write the result as JSON: each changed file's new contents, each place left to a person, the type errors before and after, each package's report, and the release the Changes were read from. |

`migrate --phase fetch|analyse <request>` is what runs inside a sandbox; it is
not meant to be run by hand.

## Environment

| Variable | Used by | |
|---|---|---|
| `INVARIANT_SIGNING_KEY` | `release`, `well-known` | The Ed25519 private key, in PEM form. `well-known` lists only its public half. |
| `INVARIANT_TOKEN` | `publish`, `status` | A token issued in the dashboard. |
| `INVARIANT_URL` | `publish`, `status`, `well-known` | The service, when not the hosted one. |
