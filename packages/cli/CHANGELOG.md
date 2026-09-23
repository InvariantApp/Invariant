# @invariant-app/cli

## 0.2.0

### Minor Changes

- 1caa64c: The release report says what callers on the old contract will notice: how many changes they will not notice, how many they carry on through with something declared lost, and how many nothing can serve, each of the last two named. With `--impact` it also says how many callers are still on each old contract, from the service's own counters.
- ea463aa: `invariant observe` stands in front of an API, adapts nothing, and reports where its answers do not match its own specification, with no value from any response in the report. A contract can be given a deprecation and a sunset date in `invariant.yaml`, which the runtime tells that contract's callers on every answer. A JSON body is read whatever the provider called its media type, which the runtime already did.
- 60a6ebf: SDK maps: `invariant publish` now sends each map in `invariant/sdks/` before the signed releases, and the client has `putSdk` and `listSdks`. A map says how an SDK names what the contract describes, which is what the migration service needs to open a pull request in a consumer's repository.

### Patch Changes

- 80b2b43: `invariant verify --rebuild` refuses a bundle whose source commit is not a commit id before handing it to git, where a signed `--orphan=x` would have been read as an option.
- Updated dependencies [34628d6]
- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [7c44320]
- Updated dependencies [2ceed93]
- Updated dependencies [80b2b43]
- Updated dependencies [fad78f7]
- Updated dependencies [fad78f7]
- Updated dependencies [7c44320]
- Updated dependencies [e4f8878]
- Updated dependencies [2e2c416]
- Updated dependencies [ea463aa]
- Updated dependencies [1e2171a]
- Updated dependencies [7c44320]
- Updated dependencies [80b2b43]
- Updated dependencies [42dacb5]
- Updated dependencies [5ed3fbf]
- Updated dependencies [7b002b6]
- Updated dependencies [a136b88]
- Updated dependencies [48948ea]
- Updated dependencies [60a6ebf]
- Updated dependencies [e5723a1]
- Updated dependencies [9ee5787]
- Updated dependencies [51ab64d]
- Updated dependencies [73d1913]
- Updated dependencies [80b2b43]
- Updated dependencies [e5723a1]
- Updated dependencies [d712bcf]
- Updated dependencies [fad78f7]
  - @invariant-app/proposer@0.2.0
  - @invariant-app/diff@0.2.0
  - @invariant-app/compiler@0.2.0
  - @invariant-app/ir@0.2.0
  - @invariant-app/contract@0.2.0
  - @invariant-app/verifier@0.2.0
  - @invariant-app/client@0.2.0
  - @invariant-app/bundle@0.2.0
