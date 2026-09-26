# Migrating your consumers

The runtime keeps old callers working. Migration is how they stop being old: when you publish a
release, every consumer who connected their repositories gets a draft pull request that moves
their code to the new contract and their SDK to the version that speaks it.

Nobody's code is run to do this. The repository is fetched as files, read for its types, edited
as text and type-checked against the new SDK. The pull request is a draft until the consumer's own
checks pass on it, and it is never merged for them.

## What it needs from you

**An SDK map** for each SDK package your consumers use. It says what the SDK calls each schema in
your contract, and which package and version speak the new contract. Keep one JSON file per
package in `invariant/sdks/`, and `invariant publish` sends them before your releases:

```json
{
  "package": "@acme/sdk",
  "upgradeTo": { "package": "@acme/sdk", "version": "3.0.0" },
  "types": { "Payment": "Payment", "PaymentCreateParams": "PaymentCreateParams" },
  "accessors": [{ "from": ["charges"], "to": ["payments"] }],
  "helpers": { "toMinor": "toMinorUnits", "fromMinor": "fromMinorUnits" }
}
```

| Field | What it says |
|---|---|
| `package` | The package your consumers depend on today, as their `package.json` names it. |
| `upgradeTo` | The package and version that speak the contract you are releasing. It can be the same package at a newer version, or a new package. |
| `types` | Each schema in your contract, by name, to the type the SDK exports for it. |
| `accessors` | Resource paths that moved, so `client.charges.create` becomes `client.payments.create`. |
| `pin` | Where a consumer names the contract it speaks, as an `apiVersion` option: `{ "type", "property", "label" }`. |
| `operations` | The SDK method that calls each operation, keyed `method path`, so a call to a retired operation is found and flagged. |
| `helpers` | Exact conversion helpers the SDK exports, so a unit change is never written as floating-point arithmetic in someone's code. |

**Your consumers' usage**, which your runtime already reports. It tells the service which
contract each consumer speaks, so a consumer two releases behind gets both releases' Changes at
once. A consumer with no usage yet is taken to be one release behind.

## What your consumers do

They follow a link you send them from the dashboard's Consumers page and choose which
repositories to connect. The GitHub App asks for read access to code and write access to pull
requests on those repositories, and nothing else: no workflows, no administration, nothing
organisation-wide.

### Consumers not on GitHub

A consumer whose code is somewhere else, or who would rather run the migration themselves, needs
no account at all. Your published releases are readable by anyone from the service's public,
cached endpoint, and `invariant migrate` reads them given your domain and your API's id:

```json
{
  "language": "typescript",
  "repo": ".",
  "release": { "provider": "api.acme.example", "api": "acme-payments" },
  "sdk": "acme-sdk.json"
}
```

```
npx -p @invariant-app/cli -p @invariant-app/migrate-ts invariant migrate job.json --write
```

(`@invariant-app/migrate-py` or `@invariant-app/migrate-go` in place of `migrate-ts` for Python
or Go.)

For that to work you serve [`/.well-known/invariant.json`](well-known.md) on your domain, listing
the keys you sign releases with. The consumer's CLI reads your keys from there and nowhere else,
so a release is trusted because you signed it, never because the service handed it over. See
[the job's `release`](reference/cli.md#a-providers-published-release) for choosing a release and
applying several steps at once.

## What happens when you publish

For each connected repository:

1. The repository's default branch and the SDK it depends on are fetched as files.
2. The migration engine finds every place the code touches what changed, and edits it.
3. The result is type-checked against the SDK version that speaks the new contract. A migration
   that would leave a new type error opens no pull request; the dashboard says why.
4. A draft pull request is opened on `invariant/<release label>`, with the SDK bumped in
   `package.json` and every hunk explained. Places the engine will not change on its own are
   listed in the description, with the reason.
5. When the consumer's checks pass on it, and nothing is left for a person, it is marked ready for
   review.

Publishing the same release again changes nothing, and a repository connected later is migrated
the next time you publish.

A repository that is a monorepo still gets one pull request. Each of its packages (npm, pnpm or
yarn workspaces, each `pyproject.toml`, each Go module in a `go.work` or beside another) is
migrated on its own, from the release of your SDK that package's manifest and lockfile say it
uses, and the edits are put together. The migration's result says, package by package, what
was changed, what was left to a person, and which packages do not use your SDK at all.

Steps 1 and 2 run apart, each in a sandbox of its own. The fetch downloads the SDK releases with
install scripts off and can reach the package registries and nothing else; it never sees the
repository. The analysis reads the repository against them with no network at all, and can
write only its result. A consumer can run the same migration themselves with
[`invariant migrate`](reference/cli.md#invariant-migrate), in their own process or in containers.
