# @invariant-app/client

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- 60a6ebf: SDK maps: `invariant publish` now sends each map in `invariant/sdks/` before the signed releases, and the client has `putSdk` and `listSdks`. A map says how an SDK names what the contract describes, which is what the migration service needs to open a pull request in a consumer's repository.
